import soundfile as sf
import numpy as np
import argparse
import os
import subprocess
import time
from voxcpm import VoxCPM
from text_utils import truncate_to_maxchars, truncate_to_maxsentences

# Parse command line arguments
parser = argparse.ArgumentParser(description='Generate speech from text using VoxCPM')
parser.add_argument('prompt', type=str, nargs='+', help='Text prompt(s) for speech generation (can be one or more prompts)')

# Create mutually exclusive group for truncation options
truncation_group = parser.add_mutually_exclusive_group()
truncation_group.add_argument('--maxchars', type=int, default=None, help='Maximum number of characters, truncating at sentence boundaries')
truncation_group.add_argument('--maxsentences', type=int, default=None, help='Maximum number of sentences to process')

# Voice cloning options
parser.add_argument('--prompt-wav-path', type=str, default=None, help='Path to a prompt speech WAV file for voice cloning')
parser.add_argument('--prompt-text', type=str, default=None, help='Reference text corresponding to the prompt WAV file')
parser.add_argument('--autoplay', action='store_true', help='Play audio files after generation (disabled by default for remote servers)')

args = parser.parse_args()

# nargs='+' always returns a list, even for a single prompt
prompts = args.prompt

model = VoxCPM.from_pretrained("openbmb/VoxCPM-0.5B")

# Ensure output directory exists
output_dir = os.path.join(os.path.dirname(__file__), 'audio', 'output')
os.makedirs(output_dir, exist_ok=True)

# Process each prompt
total_prompts = len(prompts)
generated_files = []
for idx, prompt in enumerate(prompts, start=1):
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
                    prompt_text = f.read().strip()
            else:
                # If either file is missing, warn and don't use voice cloning for this prompt
                missing_files = []
                if not os.path.exists(speaker_wav):
                    missing_files.append("WAV")
                if not os.path.exists(speaker_txt):
                    missing_files.append("TXT")
                print(f"Warning: Missing {', '.join(missing_files)} file(s) for speaker '{speaker_name}'. Voice cloning disabled for this prompt.")
    
    # Truncate prompt if maxchars or maxsentences is provided
    if args.maxchars is not None:
        text_to_process = truncate_to_maxchars(text_to_process, args.maxchars)
    elif args.maxsentences is not None:
        text_to_process = truncate_to_maxsentences(text_to_process, args.maxsentences)

    # Generate output filename using epoch milliseconds timestamp
    timestamp_ms = int(time.time() * 1000)
    output_filename = f"{timestamp_ms}.wav"
    
    # Non-streaming
    wav = model.generate(
        text=text_to_process,
        prompt_wav_path=prompt_wav_path,      # optional: path to a prompt speech for voice cloning
        prompt_text=prompt_text,          # optional: reference text
        cfg_value=2.0,             # LM guidance on LocDiT, higher for better adherence to the prompt, but maybe worse
        inference_timesteps=10,   # LocDiT inference timesteps, higher for better result, lower for fast speed
        normalize=True,           # enable external TN tool
        denoise=True,             # enable external Denoise tool
        retry_badcase=True,        # enable retrying mode for some bad cases (unstoppable)
        retry_badcase_max_times=3,  # maximum retrying times
        retry_badcase_ratio_threshold=6.0, # maximum length restriction for bad case detection (simple but effective), it could be adjusted for slow pace speech
    )

    full_output_path = os.path.join(output_dir, output_filename)
    sf.write(full_output_path, wav, 16000)
    print(f"[{idx}/{total_prompts}] saved: {full_output_path}")
    generated_files.append(full_output_path)
    
    # Play the file immediately in the background (non-blocking) if autoplay is enabled
    if args.autoplay:
        subprocess.Popen(['aplay', full_output_path], 
                         stdout=subprocess.DEVNULL, 
                         stderr=subprocess.DEVNULL)

# Set LAST_WAV environment variable to the last generated file
if generated_files:
    last_output_path = os.path.abspath(generated_files[-1])
    os.environ['LAST_WAV'] = last_output_path
