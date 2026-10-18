#!/usr/bin/env python3
"""Run on the home proxy as its normal user, after copying the built release here.

Requires Python/PyYAML, Node 24, Tailscale operator access, and user lingering.
Never outputs keys, credentials, configuration bodies, or OAuth URLs.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import urllib.request

import yaml


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def write_private(path, content):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    with os.fdopen(fd, 'w') as stream:
        stream.write(content)
    os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True, type=Path)
    args = parser.parse_args()
    home = Path.home()
    release = Path(__file__).resolve().parent
    if os.geteuid() == 0:
        raise SystemExit('Run as the existing proxy user, not root.')
    if not run(str(args.node), '--version').startswith('v24.'):
        raise SystemExit('Use the pinned Fleet Node 24 runtime.')
    if run('loginctl', 'show-user', str(os.getuid()), '-p', 'Linger', '--value') != 'yes':
        raise SystemExit('Enable persistent user services first: loginctl enable-linger')
    if not (release / 'management.html').is_file():
        raise SystemExit('Copy the built dist/index.html to management.html beside this script.')
    config_path = home / '.config/fleet/proxy.yaml'
    original = config_path.read_text()
    config = yaml.safe_load(original)
    if config.get('server') != {'host': '127.0.0.1', 'port': 8317}:
        raise SystemExit('Expected the existing Fleet loopback proxy on 8317; inspect before proceeding.')
    status = json.loads(run('tailscale', 'status', '--json'))
    if status.get('BackendState') != 'Running':
        raise SystemExit('Tailscale must be connected.')
    dns = status['Self']['DNSName'].rstrip('.')
    origin = f'https://{dns}:10443'
    serve = json.loads(run('tailscale', 'serve', 'status', '--json'))
    if any(serve.get('AllowFunnel', {}).values()):
        raise SystemExit('Refusing a host with Funnel enabled.')
    web = serve.get('Web', {})
    inference = web.get(f'{dns}:443', {})
    old_mapping = {'Handlers': {'/': {'Proxy': 'http://127.0.0.1:8317'}}}
    filtered_mapping = {'Handlers': {'/': {'Proxy': 'http://127.0.0.1:8316'}}}
    admin_mapping = {'Handlers': {'/': {'Proxy': 'http://127.0.0.1:8318'}}}
    if inference not in (old_mapping, filtered_mapping):
        raise SystemExit('Unexpected HTTPS 443 mapping; preserving it unchanged.')
    if f'{dns}:10443' in web and web[f'{dns}:10443'] != admin_mapping:
        raise SystemExit('HTTPS 10443 already belongs to another service.')
    if '10443' in serve.get('TCP', {}) and serve['TCP']['10443'] != {'HTTPS': True}:
        raise SystemExit('TCP 10443 is already in use.')
    # An operator must check active work before running an upgrade. Never restart here.
    for name in ['proxy-console-admin', 'proxy-console-inference']:
        if subprocess.run(['systemctl', '--user', 'is-active', '--quiet', name]).returncode == 0:
            raise SystemExit('Already running. Use the documented upgrade procedure after checking active work.')
    key_path = home / '.config/proxy-console/management-key'
    if not key_path.exists():
        write_private(key_path, secrets.token_urlsafe(48) + '\n')
    key = key_path.read_text().strip()
    if len(key) < 32:
        raise SystemExit('Management key is too short.')
    for mode, port in [('inference', 8316), ('admin', 8318)]:
        unit = f'''[Unit]
Description=Matthew's proxy console {mode} boundary
After=network-online.target

[Service]
ExecStart={args.node} {release}/gateway.mjs {mode}
Environment=CONSOLE_KEY_FILE={key_path}
Environment=CONSOLE_ORIGIN={origin}
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
'''
        write_private(home / f'.config/systemd/user/proxy-console-{mode}.service', unit)
    run('systemctl', '--user', 'daemon-reload')
    run('systemctl', '--user', 'enable', '--now', 'proxy-console-inference', 'proxy-console-admin')
    for _ in range(30):
        try:
            with urllib.request.urlopen('http://127.0.0.1:8318/') as response:
                if response.status == 200:
                    break
        except OSError:
            time.sleep(0.2)
    else:
        raise SystemExit('Console did not start; management remains unchanged.')
    # Close the worker-facing management route BEFORE enabling management.
    run('tailscale', 'serve', '--bg', '--https=443', 'http://127.0.0.1:8316')
    check = json.loads(run('tailscale', 'serve', 'status', '--json'))
    if check['Web'][f'{dns}:443'] != filtered_mapping:
        raise SystemExit('Inference filter verification failed; management remains unchanged.')
    if any(value for value in check.get('AllowFunnel', {}).values()):
        raise SystemExit('Unexpected Funnel exposure; management remains unchanged.')
    write_private(home / '.config/fleet/proxy-before-console.yaml', original)
    write_private(home / '.config/fleet/proxy-console-managed', 'Runtime config is owned by proxy-console; Fleet must not overwrite it.\n')
    config.setdefault('management', {}).update({
        'allow-remote': False, 'secret-key': key, 'disable-control-panel': True,
    })
    # Linux inotify watches the existing inode; replacing it drops the watch.
    rendered = yaml.safe_dump(config, sort_keys=False)
    with config_path.open('w') as stream:
        stream.write(rendered)
        stream.flush()
        os.fsync(stream.fileno())
    # CLIProxyAPI v8.0.32 watches this config and enables management without a restart.
    for _ in range(50):
        request = urllib.request.Request('http://127.0.0.1:8318/v8/management/config',
                                         headers={'Authorization': f'Bearer {key}'})
        try:
            with urllib.request.urlopen(request) as response:
                if response.status == 200:
                    break
        except OSError:
            time.sleep(0.2)
    else:
        raise SystemExit('Management hot reload did not verify. Inspect services; do not expose raw 8317.')
    run('tailscale', 'serve', '--bg', '--https=10443', 'http://127.0.0.1:8318')
    final = json.loads(run('tailscale', 'serve', 'status', '--json'))
    for address, mapping in web.items():
        if address not in (f'{dns}:443', f'{dns}:10443') and final['Web'].get(address) != mapping:
            raise SystemExit('Unrelated Serve mapping changed unexpectedly.')
    print(f'Console ready: {origin}/#/quota')
    print('Management key remains in ~/.config/proxy-console/management-key (mode 0600).')
    print('Proxy was hot-reloaded, not restarted. Inference remains on HTTPS 443.')


if __name__ == '__main__':
    main()
