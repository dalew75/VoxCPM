import soundfile as sf
import numpy as np
import argparse
import os
import subprocess
import time
import json
import asyncio
from voxcpm import VoxCPM
from text_utils import truncate_to_maxchars, truncate_to_maxsentences

# Parse command line arguments
parser = argparse.ArgumentParser(description='Generate speech from text using VoxCPM')
parser.add_argument('prompt', type=str, nargs='*', help='Text prompt(s) for speech generation (can be one or more prompts)')

# Create mutually exclusive group for truncation options
truncation_group = parser.add_mutually_exclusive_group()
truncation_group.add_argument('--maxchars', type=int, default=None, help='Maximum number of characters, truncating at sentence boundaries')
truncation_group.add_argument('--maxsentences', type=int, default=None, help='Maximum number of sentences to process')

# Voice cloning options
parser.add_argument('--prompt-wav-path', type=str, default=None, help='Path to a prompt speech WAV file for voice cloning')
parser.add_argument('--prompt-text', type=str, default=None, help='Reference text corresponding to the prompt WAV file')
parser.add_argument('--autoplay', action='store_true', help='Play audio files after generation (disabled by default for remote servers)')

# Subscription mode options
parser.add_argument('--subscription', action='store_true', help='Run in subscription mode, listening for NATS messages')
parser.add_argument('--nats-server', type=str, default='nats://localhost:4222', help='NATS server address')
parser.add_argument('--nats-subject', type=str, default='voxcpm.generate', help='NATS subject to subscribe to')

args = parser.parse_args()

model = VoxCPM.from_pretrained("openbmb/VoxCPM-0.5B")

# Ensure output directory exists
output_dir = os.path.join(os.path.dirname(__file__), 'audio', 'output')
os.makedirs(output_dir, exist_ok=True)

# Function to process a single prompt and return the generated filename
def process_prompt(prompt, idx, total_prompts, reply_subject=None, nats_client=None):
    """Process a single prompt and generate a WAV file. Returns the filename."""
    # Display progress counter
    print(f"\n{'='*60}")
    print(f"Processing: {idx}/{total_prompts}")
    print(f"{'='*60}")
    
    # Check if prompt starts with a speaker prefix (e.g., "joe:" or "lex:")
    speaker_name = None
    text_to_process = prompt
    prompt_wav_path = args.prompt_wav_path
    prompt_text = args.prompt_text
    
    # Parse speaker prefix if present (format: "speaker: text")
    if ':' in prompt:
        parts = prompt.split(':', 1)
        potential_speaker = parts[0].strip().lower()
        # Check if it looks like a speaker prefix (simple word, no spaces, lowercase)
        if len(parts) == 2 and potential_speaker and ' ' not in potential_speaker:
            speaker_name = potential_speaker
            text_to_process = parts[1].strip()
            
            # Look up voice files for this speaker
            voices_dir = os.path.join(os.path.dirname(__file__), 'voices')
            speaker_wav = os.path.join(voices_dir, f"{speaker_name}.wav")
            speaker_txt = os.path.join(voices_dir, f"{speaker_name}.txt")
            # Log out speaker_name, speaker_wav, speaker_txt in one line
            print(f"Speaker: {speaker_name} | WAV: {speaker_wav} | TXT: {speaker_txt}")
            
            # Use speaker's voice files only if BOTH exist (required by the model)
            if os.path.exists(speaker_wav) and os.path.exists(speaker_txt):
                prompt_wav_path = speaker_wav
                with open(speaker_txt, 'r', encoding='utf-8') as f:
                    # Read the file - use only the last non-empty line
                    # The prompt_text should be the exact transcript of the WAV file
                    # Using only the last line prevents prepending unwanted text from earlier recordings
                    lines = [line.strip() for line in f.readlines() if line.strip()]
                    if lines:
                        # Use the last line (most recent recording)
                        # Clean the prompt_text: remove all trailing/leading whitespace
                        # The prompt_text should match the WAV transcript exactly
                        # Any extra content could leak into the generated output
                        prompt_text = lines[-1].strip()
                        # Normalize whitespace: replace multiple spaces with single space
                        prompt_text = ' '.join(prompt_text.split())
                    else:
                        # Fallback: read entire file if no line breaks
                        f.seek(0)
                        prompt_text = f.read().strip()
                        # Normalize whitespace for fallback case too
                        prompt_text = ' '.join(prompt_text.split())
            else:
                # If either file is missing, warn and don't use voice cloning for this prompt
                missing_files = []
                if not os.path.exists(speaker_wav):
                    missing_files.append("WAV")
                if not os.path.exists(speaker_txt):
                    missing_files.append("TXT")
                print(f"Warning: Missing {', '.join(missing_files)} file(s) for speaker '{speaker_name}'. Voice cloning disabled for this prompt.")
                # Explicitly set both to None to ensure they're not used
                prompt_wav_path = None
                prompt_text = None
    
    # Truncate prompt if maxchars or maxsentences is provided
    if args.maxchars is not None:
        text_to_process = truncate_to_maxchars(text_to_process, args.maxchars)
    elif args.maxsentences is not None:
        text_to_process = truncate_to_maxsentences(text_to_process, args.maxsentences)

    # Generate output filename using epoch milliseconds timestamp
    timestamp_ms = int(time.time() * 1000)
    output_filename = f"{timestamp_ms}.wav"
    
    # Prepare generation arguments - only include voice cloning params if both are set
    generate_kwargs = {
        'text': text_to_process,
        'cfg_value': 2.0,             # LM guidance on LocDiT, higher for better adherence to the prompt, but maybe worse
        'inference_timesteps': 10,   # LocDiT inference timesteps, higher for better result, lower for fast speed
        'normalize': True,           # enable external TN tool
        'denoise': True,             # enable external Denoise tool
        'retry_badcase': True,        # enable retrying mode for some bad cases (unstoppable)
        'retry_badcase_max_times': 3,  # maximum retrying times
        'retry_badcase_ratio_threshold': 6.0, # maximum length restriction for bad case detection (simple but effective), it could be adjusted for slow pace speech
    }
    
    # Only add voice cloning parameters if both are provided
    if prompt_wav_path is not None and prompt_text is not None:
        generate_kwargs['prompt_wav_path'] = prompt_wav_path
        generate_kwargs['prompt_text'] = prompt_text
    
    # Non-streaming
    wav = model.generate(**generate_kwargs)

    full_output_path = os.path.join(output_dir, output_filename)
    sf.write(full_output_path, wav, 16000)
    print(f"[{idx}/{total_prompts}] saved: {full_output_path}")
    
    # If in subscription mode, publish the filename to the reply subject
    # Note: This will be handled asynchronously by the caller
    if reply_subject and nats_client:
        # Schedule the publish (caller will await if needed)
        try:
            message = json.dumps({"filename": output_filename}).encode()
            # Create task for async publish
            asyncio.create_task(nats_client.publish(reply_subject, message))
            print(f"Published to {reply_subject}: {output_filename}")
        except Exception as e:
            print(f"Error publishing to NATS: {e}")
    
    # Play the file immediately in the background (non-blocking) if autoplay is enabled
    if args.autoplay:
        subprocess.Popen(['aplay', full_output_path], 
                         stdout=subprocess.DEVNULL, 
                         stderr=subprocess.DEVNULL)
    
    return output_filename

# Subscription mode handler
async def subscription_mode():
    """Run in subscription mode, listening for NATS messages."""
    try:
        import nats
    except ImportError:
        print("Error: nats-py package is required for subscription mode. Install with: pip install nats-py")
        return
    
    print(f"Connecting to NATS server: {args.nats_server}")
    nc = await nats.connect(args.nats_server)
    print(f"Connected! Subscribing to: {args.nats_subject}")
    
    async def message_handler(msg):
        """Handle incoming NATS messages."""
        try:
            data = json.loads(msg.data.decode())
            label = data.get('label', 'unknown')
            reply_subject = data.get('reply_subject')
            messages = data.get('messages', [])
            
            if not isinstance(messages, list):
                print(f"Error: 'messages' must be a list, got {type(messages)}")
                return
            
            if not reply_subject:
                print("Warning: No reply_subject provided, skipping NATS notifications")
            
            print(f"\nReceived request (label: {label}, messages: {len(messages)})")
            
            total = len(messages)
            for idx, prompt in enumerate(messages, start=1):
                # Process synchronously (model.generate is blocking anyway)
                process_prompt(prompt, idx, total, reply_subject, nc)
                # Small delay to allow NATS publish to complete
                await asyncio.sleep(0.1)
            
        except json.JSONDecodeError as e:
            print(f"Error decoding JSON message: {e}")
        except Exception as e:
            print(f"Error processing message: {e}")
    
    sub = await nc.subscribe(args.nats_subject, cb=message_handler)
    print(f"Subscribed! Waiting for messages on {args.nats_subject}...")
    print("Press Ctrl+C to exit\n")
    
    try:
        # Keep running
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        print("\nShutting down...")
        await nc.close()

# Main execution
if args.subscription:
    # Run in subscription mode
    if not args.prompt:
        # Only run subscription mode if no prompts provided
        asyncio.run(subscription_mode())
    else:
        print("Error: Cannot provide prompts when using --subscription mode")
        parser.print_help()
else:
    # Normal command-line mode
    if not args.prompt:
        print("Error: No prompts provided")
        parser.print_help()
        exit(1)
    
    prompts = args.prompt
    total_prompts = len(prompts)
    generated_files = []
    
    for idx, prompt in enumerate(prompts, start=1):
        filename = process_prompt(prompt, idx, total_prompts)
        generated_files.append(filename)
    
    # Set LAST_WAV environment variable to the last generated file
    if generated_files:
        last_output_path = os.path.join(output_dir, generated_files[-1])
        os.environ['LAST_WAV'] = os.path.abspath(last_output_path)
