#!/usr/bin/env node

const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { connect, StringCodec } = require('nats');

// Configuration
const REMOTE_HOST = 'root@134.122.40.36';
const REMOTE_PATH = '/root/VoxCPM/audio/output/';
const LOCAL_DIR = './audio_synced'; // Use dedicated directory for safety
const RSYNC_INTERVAL = parseInt(process.env.RSYNC_INTERVAL || '0', 10); // Sync interval in ms (0 = NATS-only mode)
const IDLE_TIMEOUT = 30000; // Exit if no new files for 10 seconds
const MAX_SYNC_RETRIES = 3; // Max retries for failed syncs

// NATS configuration
const NATS_SERVER = process.env.NATS_SERVER || 'nats://localhost:4222';
const NATS_SUBJECT = process.env.NATS_SUBJECT || 'voxcpm.files'; // Subject to listen for file notifications

// State tracking
const playedFiles = new Set();
const playQueue = []; // Queue of files to play (in order)
let rsyncProcess = null;
let isPlaying = false;
let lastFileCount = 0;
let idleTimer = null;
let natsClient = null;
const sc = StringCodec();

// Get all WAV files in directory, sorted by filename (timestamp order)
function getWavFiles() {
    try {
        const files = fs.readdirSync(LOCAL_DIR)
            .filter(file => file.endsWith('.wav'))
            .sort(); // Natural sort works for timestamps
        return files;
    } catch (err) {
        console.error(`Error reading directory: ${err.message}`);
        return [];
    }
}

// Play a WAV file using aplay
function playFile(filename) {
    return new Promise((resolve, reject) => {
        const filepath = path.join(LOCAL_DIR, filename);
        console.log(`Playing: ${filename}`);
        
        const aplay = spawn('aplay', [filepath]);
        
        aplay.stdout.on('data', (data) => {
            process.stdout.write(data);
        });
        
        aplay.stderr.on('data', (data) => {
            process.stderr.write(data);
        });
        
        aplay.on('close', (code) => {
            if (code === 0) {
                console.log(`Finished: ${filename}`);
                resolve();
            } else {
                console.error(`aplay exited with code ${code} for ${filename}`);
                reject(new Error(`aplay exited with code ${code}`));
            }
        });
        
        aplay.on('error', (err) => {
            console.error(`Error playing ${filename}: ${err.message}`);
            reject(err);
        });
    });
}

// Sync files from remote (ONLY .wav files, NO delete)
function syncFiles() {
    return new Promise((resolve, reject) => {
        // Only sync .wav files, exclude everything else for safety
        const rsync = spawn('rsync', [
            '-avz',
            '--include', '*.wav',
            '--exclude', '*',
            '--timeout=10', // 10 second timeout for connections
            `${REMOTE_HOST}:${REMOTE_PATH}`,
            LOCAL_DIR
        ]);
        
        let stdout = '';
        let stderr = '';
        
        rsync.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        
        rsync.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        
        rsync.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                // Check if it's a connection error (non-critical)
                const isConnectionError = stderr.includes('Connection refused') || 
                                         stderr.includes('Connection timed out') ||
                                         stderr.includes('Network is unreachable') ||
                                         code === 255; // SSH connection error
                
                if (isConnectionError) {
                    // Connection errors are non-fatal - just log and resolve
                    // The next sync attempt will try again
                    console.warn(`Sync connection issue (will retry): ${stderr.trim() || `code ${code}`}`);
                    resolve(); // Resolve instead of reject to continue operation
                } else if (code === 23 || code === 24) {
                    // Partial transfer or vanished source files - not critical
                    resolve();
                } else {
                    // Other errors - still resolve to keep going, but log
                    console.warn(`Sync warning (code ${code}): ${stderr.trim() || 'unknown error'}`);
                    resolve();
                }
            }
        });
        
        rsync.on('error', (err) => {
            // Spawn errors (like command not found) are more serious
            console.error(`Sync spawn error: ${err.message}`);
            reject(err);
        });
    });
}

// Combine all WAV files into one file
async function combineWavFiles() {
    return new Promise((resolve, reject) => {
        const files = getWavFiles();
        
        if (files.length === 0) {
            console.log('No WAV files to combine.');
            resolve();
            return;
        }
        
        console.log(`\nCombining ${files.length} WAV files into combined.wav...`);
        
        // Create list file with sorted filenames (use absolute paths for reliability)
        const listPath = path.join(LOCAL_DIR, 'list.txt');
        const listContent = files.map(file => {
            const absolutePath = path.join(LOCAL_DIR, file);
            return `file '${absolutePath}'`;
        }).join('\n') + '\n';
        
        try {
            fs.writeFileSync(listPath, listContent, 'utf8');
        } catch (err) {
            reject(new Error(`Failed to create list file: ${err.message}`));
            return;
        }
        
        // Use ffmpeg to combine files
        const outputPath = path.join(LOCAL_DIR, 'combined.wav');
        const ffmpeg = spawn('ffmpeg', [
            '-f', 'concat',
            '-safe', '0',
            '-i', listPath,
            '-c', 'copy',
            '-y', // Overwrite output file if it exists
            outputPath
        ], {
            cwd: LOCAL_DIR // Run from the local directory
        });
        
        let stderr = '';
        
        ffmpeg.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        
        ffmpeg.on('close', (code) => {
            // Clean up list file
            try {
                fs.unlinkSync(listPath);
            } catch (err) {
                // Ignore cleanup errors
            }
            
            if (code === 0) {
                console.log(`Successfully created: ${outputPath}`);
                resolve();
            } else {
                reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
            }
        });
        
        ffmpeg.on('error', (err) => {
            reject(new Error(`ffmpeg spawn error: ${err.message}`));
        });
    });
}

// Process and play files
async function processFiles() {
    // First, check if there's a file in the play queue that's ready to play
    if (playQueue.length > 0 && !isPlaying) {
        const queuedFile = playQueue[0];
        const filePath = path.join(LOCAL_DIR, queuedFile);
        
        // Check if the file exists locally
        if (fs.existsSync(filePath)) {
            // Remove from queue and play
            playQueue.shift();
            isPlaying = true;
            
            try {
                await playFile(queuedFile);
                playedFiles.add(queuedFile);
            } catch (err) {
                console.error(`Error playing ${queuedFile}: ${err.message}`);
                playedFiles.add(queuedFile);
            } finally {
                isPlaying = false;
            }
            return;
        }
        // File not ready yet, wait for sync
    }
    
    const files = getWavFiles();
    const unplayedFiles = files.filter(file => !playedFiles.has(file) && !playQueue.includes(file));
    
    // Update file count for idle detection
    const currentFileCount = files.length;
    if (currentFileCount !== lastFileCount) {
        lastFileCount = currentFileCount;
        // Reset idle timer when new files appear
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }
    }
    
    // If no unplayed files and queue is empty and we're not currently playing, check for idle
    if (unplayedFiles.length === 0 && playQueue.length === 0 && !isPlaying) {
        if (!idleTimer) {
            idleTimer = setTimeout(async () => {
                console.log('\nNo new files detected. All files have been played.');
                console.log('Combining all WAV files...');
                
                // Combine all WAV files before exiting
                try {
                    //await combineWavFiles();
                } catch (err) {
                    console.error(`Error combining files: ${err.message}`);
                }
                
                console.log('Exiting...');
                if (rsyncProcess) {
                    rsyncProcess.kill();
                }
                if (natsClient) {
                    await natsClient.close();
                }
                process.exit(0);
            }, IDLE_TIMEOUT);
        }
        return;
    }
    
    // Play the next unplayed file (if not in queue)
    if (unplayedFiles.length > 0 && !isPlaying) {
        const nextFile = unplayedFiles[0];
        isPlaying = true;
        
        try {
            await playFile(nextFile);
            playedFiles.add(nextFile);
        } catch (err) {
            console.error(`Error playing ${nextFile}: ${err.message}`);
            // Mark as played anyway to avoid getting stuck
            playedFiles.add(nextFile);
        } finally {
            isPlaying = false;
        }
    }
}

// Main loop
async function main() {
    console.log('Starting sync and play...');
    console.log(`Remote: ${REMOTE_HOST}:${REMOTE_PATH}`);
    console.log(`Local: ${LOCAL_DIR}`);
    console.log(`Sync interval: ${RSYNC_INTERVAL}ms`);
    console.log(`Idle timeout: ${IDLE_TIMEOUT}ms`);
    console.log('Safety: Only syncing .wav files, no delete operations');
    
    // Connect to NATS
    try {
        console.log(`Connecting to NATS: ${NATS_SERVER}`);
        natsClient = await connect({ servers: NATS_SERVER });
        console.log('Connected to NATS!');
        
        // Subscribe to file notifications
        const sub = natsClient.subscribe(NATS_SUBJECT);
        console.log(`Subscribed to: ${NATS_SUBJECT}\n`);
        
        // Handle NATS messages
        (async () => {
            for await (const msg of sub) {
                try {
                    const data = JSON.parse(sc.decode(msg.data));
                    const filename = data.filename;
                    
                    if (filename && filename.endsWith('.wav')) {
                        // If RSYNC_INTERVAL is 0, trigger a sync when we get a NATS notification
                        if (RSYNC_INTERVAL === 0) {
                            console.log(`NATS notification received, syncing for: ${filename}`);
                            try {
                                await syncFiles();
                            } catch (err) {
                                console.error(`Sync error for ${filename}: ${err.message}`);
                            }
                        }
                        
                        // Add to play queue if not already played or queued
                        if (!playedFiles.has(filename) && !playQueue.includes(filename)) {
                            playQueue.push(filename);
                            console.log(`Added to play queue: ${filename} (queue size: ${playQueue.length})`);
                            
                            // Reset idle timer when new file is queued
                            if (idleTimer) {
                                clearTimeout(idleTimer);
                                idleTimer = null;
                            }
                        }
                    }
                } catch (err) {
                    console.error(`Error processing NATS message: ${err.message}`);
                }
            }
        })().catch(err => {
            console.error(`NATS subscription error: ${err.message}`);
        });
    } catch (err) {
        console.warn(`NATS connection failed: ${err.message}`);
        console.warn('Continuing without NATS notifications...\n');
    }
    
    // Ensure local directory exists
    if (!fs.existsSync(LOCAL_DIR)) {
        fs.mkdirSync(LOCAL_DIR, { recursive: true });
        console.log(`Created local directory: ${LOCAL_DIR}\n`);
    }
    
    // Initial sync (only if not in NATS-only mode)
    if (RSYNC_INTERVAL > 0) {
        try {
            await syncFiles();
            console.log('Initial sync complete.\n');
        } catch (err) {
            console.error(`Initial sync failed: ${err.message}`);
            process.exit(1);
        }
    } else {
        console.log('NATS-only mode: No periodic syncing, will sync on NATS notifications only.\n');
    }
    
    // Start continuous sync and play loop (only if RSYNC_INTERVAL > 0)
    let syncInterval = null;
    if (RSYNC_INTERVAL > 0) {
        syncInterval = setInterval(async () => {
            try {
                await syncFiles();
            } catch (err) {
                // Only log critical errors (spawn failures, etc.)
                // Connection errors are already handled in syncFiles()
                console.error(`Sync critical error: ${err.message}`);
            }
        }, RSYNC_INTERVAL);
    }
    
    // Process files more frequently than sync
    const processInterval = setInterval(async () => {
        await processFiles();
    }, 500); // Check every 500ms for new files to play
    
    // Handle cleanup on exit
    process.on('SIGINT', async () => {
        console.log('\nInterrupted. Cleaning up...');
        if (syncInterval) {
            clearInterval(syncInterval);
        }
        clearInterval(processInterval);
        if (idleTimer) {
            clearTimeout(idleTimer);
        }
        if (natsClient) {
            await natsClient.close();
        }
        process.exit(0);
    });
}

// Run
main().catch(err => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
});

