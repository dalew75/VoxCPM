#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { connect, StringCodec } = require('nats');

// Configuration
const REMOTE_HOST = 'root@134.122.40.36';
const REMOTE_PATH = '/root/VoxCPM-latest/audio/output/';
const LOCAL_DIR = './audio_synced';
const IDLE_TIMEOUT = 900000; // Exit if no new files for 30 seconds

// NATS configuration
const NATS_SERVER = process.env.NATS_SERVER || 'nats://localhost:4222';
const NATS_SUBJECT = process.env.NATS_SUBJECT || 'voxcpm.files';

// State tracking
const playedFiles = new Set();
const playQueue = []; // Queue of files to play (in order)
let isPlaying = false;
let isSyncing = false; // Track if a sync is in progress
let lastSyncTime = 0; // Track when last sync completed
let idleTimer = null;
let natsClient = null;
const sc = StringCodec();

// Sync configuration
const SYNC_DELAY = 1000; // Minimum delay between syncs (1 second)
const MAX_SYNC_RETRIES = 3;
const RETRY_DELAY = 2000; // 2 seconds between retries

// SSH ControlMaster socket path for connection reuse
const SSH_CONTROL_DIR = path.join(os.tmpdir(), 'voxcpm-ssh');
const SSH_CONTROL_PATH = path.join(SSH_CONTROL_DIR, `control-${REMOTE_HOST.replace(/[@:]/g, '_')}`);

// Ensure SSH control directory exists
function ensureSSHControlDir() {
    if (!fs.existsSync(SSH_CONTROL_DIR)) {
        fs.mkdirSync(SSH_CONTROL_DIR, { recursive: true, mode: 0o700 });
    }
}

// Sync a single file from remote using scp with connection reuse
function syncFile(filename, retryCount = 0) {
    return new Promise((resolve, reject) => {
        // Ensure control directory exists
        ensureSSHControlDir();
        
        const remoteFile = `${REMOTE_HOST}:${REMOTE_PATH}${filename}`;
        const localFile = path.join(LOCAL_DIR, filename);
        
        // Add delay if syncing too quickly after last sync
        const timeSinceLastSync = Date.now() - lastSyncTime;
        const delayNeeded = Math.max(0, SYNC_DELAY - timeSinceLastSync);
        
        const doSync = () => {
            const scp = spawn('scp', [
                '-o', 'ConnectTimeout=15',
                '-o', 'StrictHostKeyChecking=no',
                '-o', 'ServerAliveInterval=10',
                '-o', 'ServerAliveCountMax=3',
                '-o', `ControlMaster=auto`,
                '-o', `ControlPath=${SSH_CONTROL_PATH}`,
                '-o', 'ControlPersist=300', // Keep connection alive for 5 minutes
                '-q', // Quiet mode (suppress progress)
                remoteFile,
                localFile
            ]);
            
            let stderr = '';
            
            scp.stderr.on('data', (data) => {
                stderr += data.toString();
            });
            
            scp.on('close', (code) => {
                if (code === 0) {
                    lastSyncTime = Date.now();
                    console.log(`Successfully synced: ${filename}`);
                    resolve();
                } else {
                    const isConnectionError = stderr.includes('Connection refused') || 
                                             stderr.includes('Connection timed out') ||
                                             stderr.includes('Network is unreachable') ||
                                             stderr.includes('Connection closed') ||
                                             stderr.includes('Connection reset') ||
                                             code === 255;
                    
                    if (isConnectionError && retryCount < MAX_SYNC_RETRIES) {
                        // Retry with exponential backoff
                        const retryDelay = RETRY_DELAY * Math.pow(2, retryCount);
                        console.warn(`SCP connection error for ${filename} (retry ${retryCount + 1}/${MAX_SYNC_RETRIES} in ${retryDelay}ms): ${stderr.trim() || `code ${code}`}`);
                        
                        setTimeout(() => {
                            syncFile(filename, retryCount + 1)
                                .then(resolve)
                                .catch(reject);
                        }, retryDelay);
                    } else {
                        reject(new Error(`scp exited with code ${code}: ${stderr.trim()}`));
                    }
                }
            });
            
            scp.on('error', (err) => {
                if (retryCount < MAX_SYNC_RETRIES) {
                    const retryDelay = RETRY_DELAY * Math.pow(2, retryCount);
                    console.warn(`SCP spawn error for ${filename} (retry ${retryCount + 1}/${MAX_SYNC_RETRIES} in ${retryDelay}ms): ${err.message}`);
                    
                    setTimeout(() => {
                        syncFile(filename, retryCount + 1)
                            .then(resolve)
                            .catch(reject);
                    }, retryDelay);
                } else {
                    reject(err);
                }
            });
        };
        
        if (delayNeeded > 0) {
            setTimeout(doSync, delayNeeded);
        } else {
            doSync();
        }
    });
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

// Process and play files from queue - sequential: play -> sync next -> play next
async function processQueue() {
    // If queue is empty and not playing, check for idle
    if (playQueue.length === 0 && !isPlaying && !isSyncing) {
        if (!idleTimer) {
            idleTimer = setTimeout(() => {
                console.log('\nNo new files detected. All files have been played. Exiting...');
                if (natsClient) {
                    natsClient.close();
                }
                process.exit(0);
            }, IDLE_TIMEOUT);
        }
        return;
    }
    
    // If we're already playing or syncing, wait
    if (isPlaying || isSyncing) {
        return;
    }
    
    // If queue is empty, nothing to do
    if (playQueue.length === 0) {
        return;
    }
    
    const nextFile = playQueue[0];
    const filePath = path.join(LOCAL_DIR, nextFile);
    
    // Check if file exists locally
    if (fs.existsSync(filePath)) {
        // File exists, remove from queue and play
        playQueue.shift();
        isPlaying = true;
        
        try {
            await playFile(nextFile);
            playedFiles.add(nextFile);
        } catch (err) {
            console.error(`Error playing ${nextFile}: ${err.message}`);
            playedFiles.add(nextFile);
        } finally {
            isPlaying = false;
            
            // After playing, check if there's a next file to sync
            if (playQueue.length > 0) {
                const nextNextFile = playQueue[0];
                const nextNextFilePath = path.join(LOCAL_DIR, nextNextFile);
                
                // If next file doesn't exist, sync it
                if (!fs.existsSync(nextNextFilePath)) {
                    isSyncing = true;
                    try {
                        await syncFile(nextNextFile);
                    } catch (err) {
                        console.error(`Failed to sync ${nextNextFile}: ${err.message}`);
                        // Will retry on next cycle
                    } finally {
                        isSyncing = false;
                    }
                }
            }
        }
    } else {
        // File doesn't exist, sync it first
        isSyncing = true;
        try {
            await syncFile(nextFile);
            // After sync completes, the next cycle will play it
        } catch (err) {
            console.error(`Failed to sync ${nextFile}: ${err.message}`);
            // Will retry on next cycle
        } finally {
            isSyncing = false;
        }
    }
}

// Main function
async function main() {
    console.log('Starting NATS-only sync and play...');
    console.log(`Remote: ${REMOTE_HOST}:${REMOTE_PATH}`);
    console.log(`Local: ${LOCAL_DIR}`);
    console.log(`NATS Server: ${NATS_SERVER}`);
    console.log(`NATS Subject: ${NATS_SUBJECT}`);
    console.log(`Idle timeout: ${IDLE_TIMEOUT}ms\n`);
    
    // Ensure local directory exists
    if (!fs.existsSync(LOCAL_DIR)) {
        fs.mkdirSync(LOCAL_DIR, { recursive: true });
        console.log(`Created local directory: ${LOCAL_DIR}`);
    }
    
    // Ensure SSH control directory exists for connection reuse
    ensureSSHControlDir();
    console.log(`SSH control path: ${SSH_CONTROL_PATH}\n`);
    
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
                    console.log('incoming data:', data);
                    const filename = data.filename;
                    
                    if (filename && filename.endsWith('.wav')) {
                        // Skip if already played
                        if (playedFiles.has(filename)) {
                            console.log(`Skipping ${filename} (already played)`);
                            continue;
                        }
                        
                        // Skip if already in queue
                        if (playQueue.includes(filename)) {
                            console.log(`Skipping ${filename} (already in queue)`);
                            continue;
                        }
                        
                        // Add to play queue
                        playQueue.push(filename);
                        console.log(`Added to play queue: ${filename} (queue size: ${playQueue.length})`);
                        
                        // Reset idle timer when new file is queued
                        if (idleTimer) {
                            clearTimeout(idleTimer);
                            idleTimer = null;
                        }
                        
                        // If this is the first file in queue and we're not playing/syncing, start processing
                        if (playQueue.length === 1 && !isPlaying && !isSyncing) {
                            // Trigger processing immediately
                            setImmediate(() => processQueue());
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
        console.error(`NATS connection failed: ${err.message}`);
        process.exit(1);
    }
    
    // Process play queue periodically
    const processInterval = setInterval(async () => {
        await processQueue();
    }, 500); // Check every 500ms
    
    // Handle cleanup on exit
    process.on('SIGINT', async () => {
        console.log('\nInterrupted. Cleaning up...');
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

