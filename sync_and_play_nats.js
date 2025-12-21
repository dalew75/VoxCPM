#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { connect, StringCodec } = require('nats');

// Configuration
const REMOTE_HOST = 'root@134.122.40.36';
const REMOTE_PATH = '/root/VoxCPM/audio/output/';
const LOCAL_DIR = './audio_synced';
const IDLE_TIMEOUT = 900000; // Exit if no new files for 30 seconds

// NATS configuration
const NATS_SERVER = process.env.NATS_SERVER || 'nats://localhost:4222';
const NATS_SUBJECT = process.env.NATS_SUBJECT || 'voxcpm.files';

// State tracking
const playedFiles = new Set();
const playQueue = []; // Queue of files to play (in order)
let isPlaying = false;
let idleTimer = null;
let natsClient = null;
const sc = StringCodec();

// Sync a specific file from remote using scp
function syncFile(filename) {
    return new Promise((resolve, reject) => {
        const remoteFile = `${REMOTE_HOST}:${REMOTE_PATH}${filename}`;
        const localFile = path.join(LOCAL_DIR, filename);
        
        const scp = spawn('scp', [
            '-o', 'ConnectTimeout=10',
            '-o', 'StrictHostKeyChecking=no',
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
                resolve();
            } else {
                const isConnectionError = stderr.includes('Connection refused') || 
                                         stderr.includes('Connection timed out') ||
                                         stderr.includes('Network is unreachable') ||
                                         stderr.includes('Connection closed') ||
                                         code === 255;
                
                if (isConnectionError) {
                    console.warn(`SCP connection issue for ${filename} (will retry): ${stderr.trim() || `code ${code}`}`);
                    reject(new Error(`Connection error: ${stderr.trim()}`));
                } else {
                    reject(new Error(`scp exited with code ${code}: ${stderr.trim()}`));
                }
            }
        });
        
        scp.on('error', (err) => {
            reject(err);
        });
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

// Process and play files from queue
async function processQueue() {
    // If queue is empty and not playing, check for idle
    if (playQueue.length === 0 && !isPlaying) {
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
    
    // Play the next file in queue if available and not currently playing
    if (playQueue.length > 0 && !isPlaying) {
        const nextFile = playQueue[0];
        const filePath = path.join(LOCAL_DIR, nextFile);
        
        // Check if file exists locally
        if (fs.existsSync(filePath)) {
            // Remove from queue and play
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
            }
        } else {
            // File doesn't exist yet, try to sync it
            console.log(`File ${nextFile} not found locally, attempting to sync...`);
            try {
                await syncFile(nextFile);
                console.log(`Successfully synced: ${nextFile}`);
            } catch (err) {
                console.error(`Failed to sync ${nextFile}: ${err.message}`);
                // Remove from queue if sync fails after a few retries
                // For now, just log and let it retry on next cycle
            }
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
        console.log(`Created local directory: ${LOCAL_DIR}\n`);
    }
    
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
                        
                        // Try to sync the file immediately
                        const filePath = path.join(LOCAL_DIR, filename);
                        if (!fs.existsSync(filePath)) {
                            console.log(`Syncing ${filename}...`);
                            syncFile(filename).then(() => {
                                console.log(`Successfully synced: ${filename}`);
                            }).catch(err => {
                                console.error(`Failed to sync ${filename}: ${err.message}`);
                            });
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
    
    // Process queue periodically
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

