import re
import random
import string

def generate_filename(prompt):
    """Generate a filename from prompt: lowercase, dashes, with random suffix."""
    # Convert to lowercase
    filename = prompt.lower()
    # Replace non-alphanumeric characters (except spaces) with dashes
    filename = re.sub(r'[^a-z0-9\s]', '-', filename)
    # Replace spaces with dashes
    filename = re.sub(r'\s+', '-', filename)
    # Remove multiple consecutive dashes
    filename = re.sub(r'-+', '-', filename)
    # Remove leading/trailing dashes
    filename = filename.strip('-')
    # Limit length to avoid very long filenames
    if len(filename) > 50:
        filename = filename[:50]
    # Generate random suffix (4 lowercase letters)
    random_suffix = ''.join(random.choices(string.ascii_lowercase, k=4))
    return f"{filename}-{random_suffix}.wav"

def truncate_to_maxchars(text, maxchars):
    """Truncate text to maxchars, stopping at sentence boundaries."""
    if len(text) <= maxchars:
        return text
    
    # Split text into sentences (ending with . ! or ?)
    # This regex finds sentence endings followed by whitespace or end of string
    sentences = re.split(r'([.!?]\s*)', text)
    
    # Recombine sentences with their punctuation
    result = []
    current_length = 0
    
    i = 0
    while i < len(sentences):
        sentence = sentences[i]
        if i + 1 < len(sentences):
            # Add the punctuation/whitespace that follows
            sentence += sentences[i + 1]
            i += 2
        else:
            i += 1
        
        # Check if adding this sentence would exceed maxchars
        if current_length + len(sentence) <= maxchars:
            result.append(sentence)
            current_length += len(sentence)
        else:
            # Can't fit this sentence, stop here
            break
    
    truncated = ''.join(result).strip()
    
    # If no sentences fit (result is empty), truncate at word boundary
    if not truncated:
        # Find the last space before maxchars
        if maxchars < len(text):
            last_space = text.rfind(' ', 0, maxchars)
            if last_space > 0:
                truncated = text[:last_space]
            else:
                # No space found, just truncate at maxchars
                truncated = text[:maxchars]
        else:
            truncated = text[:maxchars]
    
    return truncated

def truncate_to_maxsentences(text, maxsentences):
    """Truncate text to maxsentences number of sentences."""
    # Split text into sentences (ending with . ! or ?)
    sentences = re.split(r'([.!?]\s*)', text)
    
    # Recombine sentences with their punctuation
    result = []
    sentence_count = 0
    
    i = 0
    while i < len(sentences) and sentence_count < maxsentences:
        sentence = sentences[i]
        if i + 1 < len(sentences):
            # Add the punctuation/whitespace that follows
            sentence += sentences[i + 1]
            i += 2
        else:
            i += 1
        
        result.append(sentence)
        sentence_count += 1
    
    return ''.join(result).strip()

