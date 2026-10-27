#!/usr/bin/env python3
"""Authorize Google Health and save credentials privately; never print tokens."""
from __future__ import annotations
import argparse
import base64
import getpass
import hashlib
import http.server
import json
import os
from pathlib import Path
import secrets
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

PREFIX = 'https://www.googleapis.com/auth/googlehealth.'
BASE = ['activity_and_fitness.readonly', 'sleep.readonly', 'health_metrics_and_measurements.readonly']
READ = {'devices': 'settings.readonly', 'profile': 'profile.readonly', 'nutrition': 'nutrition.readonly', 'ecg': 'ecg.readonly', 'irn': 'irn.readonly', 'location': 'location.readonly'}
WRITE = {'nutrition': 'nutrition.writeonly', 'moods': 'mindfulness.writeonly', 'symptoms': 'logged_symptoms.writeonly', 'reproductive': 'reproductive_health.writeonly'}
ROOT = Path(__file__).resolve().parent.parent

def load_vars(path):
    values = {}
    if path.exists():
        for line in path.read_text().splitlines():
            if '=' in line and not line.lstrip().startswith('#'):
                key, value = line.split('=', 1)
                try: value = json.loads(value.strip())
                except ValueError: value = value.strip().strip("'\"")
                values[key.strip()] = str(value)
    return values

def save_vars(path, values):
    previous = path.read_text().splitlines() if path.exists() else []
    kept = [line for line in previous if line.split('=', 1)[0].strip() not in values]
    fd, temporary = tempfile.mkstemp(prefix='.oauth-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write('\n'.join(kept + [key + '=' + json.dumps(value) for key, value in values.items()]) + '\n')
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--features', default='', help='Comma-separated devices,profile,nutrition,ecg,irn,location')
    parser.add_argument('--all-read', action='store_true')
    parser.add_argument('--writes', default='', help='Explicit opt-in: nutrition,moods,symptoms,reproductive')
    parser.add_argument('--print-scopes', action='store_true')
    parser.add_argument('--port', type=int, default=int(os.environ.get('PORT', '53682')))
    args = parser.parse_args()
    features = list(READ) if args.all_read else list(filter(None, args.features.split(',')))
    writes = list(filter(None, args.writes.split(',')))
    if set(features) - READ.keys() or set(writes) - WRITE.keys(): parser.error('Unknown feature/write group.')
    scopes = [PREFIX + item for item in dict.fromkeys(BASE + [READ[x] for x in features] + [WRITE[x] for x in writes])]
    if args.print_scopes:
        print('\n'.join(scopes)); return
    path = ROOT / '.dev.vars'
    local = load_vars(path)
    client = os.environ.get('GOOGLE_CLIENT_ID') or local.get('GOOGLE_CLIENT_ID') or input('Google OAuth client ID: ').strip()
    secret = os.environ.get('GOOGLE_CLIENT_SECRET') or local.get('GOOGLE_CLIENT_SECRET') or getpass.getpass('Google OAuth client secret: ').strip()
    if not client or not secret: raise SystemExit('Client ID and secret are required.')
    state, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(64)
    result, done = {}, threading.Event()
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            query = urllib.parse.parse_qs(parsed.query)
            if parsed.path != '/callback' or not secrets.compare_digest(query.get('state', [''])[0], state):
                self.send_response(400); self.end_headers(); return
            result.update({key: value[0] for key, value in query.items()})
            self.send_response(200); self.send_header('Content-Type', 'text/plain'); self.end_headers()
            self.wfile.write(b'Return to your terminal. The authorization result is being processed.'); done.set()
    server = http.server.HTTPServer(('127.0.0.1', args.port), Handler)
    redirect = f'http://127.0.0.1:{server.server_port}/callback'
    params = dict(client_id=client, redirect_uri=redirect, response_type='code', scope=' '.join(scopes), access_type='offline', prompt='consent', state=state, code_challenge_method='S256', code_challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('='))
    url = 'https://accounts.google.com/o/oauth2/v2/auth?' + urllib.parse.urlencode(params)
    print('Register this redirect URI on your OAuth web client:', redirect)
    print('Requested scopes:\n' + '\n'.join(scopes))
    print('Opening Google consent. If needed, open this authorization URL:\n' + url)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        webbrowser.open(url)
        if not done.wait(600): raise SystemExit('Authorization timed out; credentials were not changed.')
    finally: server.shutdown(); server.server_close()
    if 'code' not in result: raise SystemExit('Google authorization was not completed; credentials were not changed.')
    data = urllib.parse.urlencode(dict(code=result['code'], client_id=client, client_secret=secret, redirect_uri=redirect, grant_type='authorization_code', code_verifier=verifier)).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request('https://oauth2.googleapis.com/token', data=data), timeout=30) as response: token = json.load(response)
    except urllib.error.HTTPError as error:
        raise SystemExit(f'Token exchange failed (HTTP {error.code}); credentials were not changed.') from None
    if not token.get('refresh_token'): raise SystemExit('No refresh token returned; existing credentials were preserved.')
    granted = set(token.get('scope', '').split())
    missing = set(scopes) - granted
    if missing: raise SystemExit('Not all requested scopes were granted; existing credentials were preserved. Missing: ' + ', '.join(sorted(missing)))
    save_vars(path, dict(GOOGLE_CLIENT_ID=client, GOOGLE_CLIENT_SECRET=secret, GOOGLE_REFRESH_TOKEN=token['refresh_token']))
    print('Saved credentials to .dev.vars (0600). No tokens were printed. Upload using scripts/upload-secrets.py.')
    if token.get('refresh_token_expires_in'): print('Google reports a finite refresh-token lifetime (seconds):', token['refresh_token_expires_in'])

if __name__ == '__main__':
    try: main()
    except KeyboardInterrupt: raise SystemExit(130)
