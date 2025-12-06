import soundfile as sf
import numpy as np
import argparse
import os
import subprocess
from voxcpm import VoxCPM
from text_utils import generate_filename, truncate_to_maxchars, truncate_to_maxsentences

# Parse command line arguments
parser = argparse.ArgumentParser(description='Generate speech from text using VoxCPM')
parser.add_argument('prompt', type=str, help='Text prompt for speech generation')

# Create mutually exclusive group for truncation options
truncation_group = parser.add_mutually_exclusive_group()
truncation_group.add_argument('--maxchars', type=int, default=None, help='Maximum number of characters, truncating at sentence boundaries')
truncation_group.add_argument('--maxsentences', type=int, default=None, help='Maximum number of sentences to process')

# Voice cloning options
parser.add_argument('--prompt-wav-path', type=str, default=None, help='Path to a prompt speech WAV file for voice cloning')
parser.add_argument('--prompt-text', type=str, default=None, help='Reference text corresponding to the prompt WAV file')

args = parser.parse_args()

# Truncate prompt if maxchars or maxsentences is provided
text_to_process = args.prompt
if args.maxchars is not None:
    text_to_process = truncate_to_maxchars(args.prompt, args.maxchars)
elif args.maxsentences is not None:
    text_to_process = truncate_to_maxsentences(args.prompt, args.maxsentences)

model = VoxCPM.from_pretrained("openbmb/VoxCPM-0.5B")

# Generate output filename (use original prompt for filename, not truncated version)
output_filename = generate_filename(args.prompt)
    
# Non-streaming
wav = model.generate(
    text=text_to_process,
    prompt_wav_path=args.prompt_wav_path,      # optional: path to a prompt speech for voice cloning
    prompt_text=args.prompt_text,          # optional: reference text
    cfg_value=2.0,             # LM guidance on LocDiT, higher for better adherence to the prompt, but maybe worse
    inference_timesteps=10,   # LocDiT inference timesteps, higher for better result, lower for fast speed
    normalize=True,           # enable external TN tool
    denoise=True,             # enable external Denoise tool
    retry_badcase=True,        # enable retrying mode for some bad cases (unstoppable)
    retry_badcase_max_times=3,  # maximum retrying times
    retry_badcase_ratio_threshold=6.0, # maximum length restriction for bad case detection (simple but effective), it could be adjusted for slow pace speech
)

full_output_path = os.path.join(os.path.dirname(__file__), 'audio', 'output', output_filename)
sf.write(full_output_path, wav, 16000)
print(f"saved: {full_output_path}")

# Set LAST_WAV environment variable and play the file
output_path = os.path.abspath(full_output_path)
os.environ['LAST_WAV'] = full_output_path
subprocess.run(['aplay', full_output_path])
