#!/usr/bin/env python3
"""Upload only named secrets from .dev.vars to the chosen production Worker."""
import argparse
import json
from pathlib import Path
import subprocess
from authorize import load_vars

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--config', default='wrangler.jsonc')
parser.add_argument('--webhook', action='store_true', help='Also upload WEBHOOK_SECRET and WEBHOOK_HEALTH_USER_ID')
args = parser.parse_args()
subprocess.run(['node', 'scripts/deploy.mjs', '--config', args.config, '--check'], check=True)
values = load_vars(Path('.dev.vars'))
keys = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']
if args.webhook: keys += ['WEBHOOK_SECRET', 'WEBHOOK_HEALTH_USER_ID']
if any(not values.get(key) for key in keys): raise SystemExit('Missing required secret(s); nothing uploaded.')
result = subprocess.run(['npx', 'wrangler', 'secret', 'bulk', '--env', 'production', '--config', args.config], input=json.dumps({key: values[key] for key in keys}), text=True)
raise SystemExit(result.returncode)
