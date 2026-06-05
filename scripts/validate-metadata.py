#!/usr/bin/env python3
import json
import os
import sys

def main():
    # 1. Check package.json version
    with open('package.json', 'r') as f:
        pkg = json.load(f)
        version = pkg.get('version')
    
    print(f"[check] Current package version: {version}")
    
    # 2. Check README.md
    if os.path.exists('README.md'):
        with open('README.md', 'r') as f:
            content = f.read()
            if version not in content:
                print(f"[error] Version {version} not found in README.md")
                return 1
            print("[check] README version matches.")
            
    print("[success] Metadata consistency verified.")
    return 0

if __name__ == '__main__':
    sys.exit(main())
