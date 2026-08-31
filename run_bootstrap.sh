#!/bin/bash
cd "$(dirname "$0")"
npx tsx src/bootstrap.ts "roms/Pokemon - Platinum Version (USA) (Rev 1).nds" > bootstrap_run.log 2>&1
