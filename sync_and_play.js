#!/usr/bin/env node

const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuration
const REMOTE_HOST = 'root@147.182.151.133';
const REMOTE_PATH = '/root/VoxCPM/audio/output/';
const LOCAL_DIR = './audio_synced'; // Use dedicated directory for safety
const RSYNC_INTERVAL = 10000; // Sync every 5 seconds (less aggressive)
const IDLE_TIMEOUT = 30000; // Exit if no new files for 10 seconds
const MAX_SYNC_RETRIES = 3; // Max retries for failed syncs

// State tracking
const playedFiles = new Set();
let rsyncProcess = null;
let isPlaying = false;
let lastFileCount = 0;
let idleTimer = null;

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

// Process and play files
async function processFiles() {
    const files = getWavFiles();
    const unplayedFiles = files.filter(file => !playedFiles.has(file));
    
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
    
    // If no unplayed files and we're not currently playing, check for idle
    if (unplayedFiles.length === 0 && !isPlaying) {
        if (!idleTimer) {
            idleTimer = setTimeout(() => {
                console.log('\nNo new files detected. All files have been played. Exiting...');
                if (rsyncProcess) {
                    rsyncProcess.kill();
                }
                process.exit(0);
            }, IDLE_TIMEOUT);
        }
        return;
    }
    
    // Play the next unplayed file
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
    console.log('Safety: Only syncing .wav files, no delete operations\n');
    
    // Ensure local directory exists
    if (!fs.existsSync(LOCAL_DIR)) {
        fs.mkdirSync(LOCAL_DIR, { recursive: true });
        console.log(`Created local directory: ${LOCAL_DIR}\n`);
    }
    
    // Initial sync
    try {
        await syncFiles();
        console.log('Initial sync complete.\n');
    } catch (err) {
        console.error(`Initial sync failed: ${err.message}`);
        process.exit(1);
    }
    
    // Start continuous sync and play loop
    const syncInterval = setInterval(async () => {
        try {
            await syncFiles();
        } catch (err) {
            // Only log critical errors (spawn failures, etc.)
            // Connection errors are already handled in syncFiles()
            console.error(`Sync critical error: ${err.message}`);
        }
    }, RSYNC_INTERVAL);
    
    // Process files more frequently than sync
    const processInterval = setInterval(async () => {
        await processFiles();
    }, 500); // Check every 500ms for new files to play
    
    // Handle cleanup on exit
    process.on('SIGINT', () => {
        console.log('\nInterrupted. Cleaning up...');
        clearInterval(syncInterval);
        clearInterval(processInterval);
        if (idleTimer) {
            clearTimeout(idleTimer);
        }
        process.exit(0);
    });
}

// Run
main().catch(err => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
});

