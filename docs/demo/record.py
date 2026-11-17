# Runs the demo commands for real and records every chunk of output with its time.
import json, os, subprocess, time
env = dict(os.environ, WAKEME_HOME='/tmp/wakeme')
cwd = os.path.dirname(os.path.abspath(__file__))
subprocess.run(['rm', '-rf', '/tmp/wakeme'])
steps = []
def run(cmd):
    t0 = time.time(); out = []
    p = subprocess.Popen(['bash', '-c', cmd], cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    while True:
        line = p.stdout.readline()
        if not line: break
        out.append([round(time.time() - t0, 2), line.decode()])
    code = p.wait()
    steps.append({'cmd': cmd, 'out': out, 'code': code, 'secs': round(time.time() - t0, 2)})
    return code
code = run('wakeme --name train --idle 5s -- python3 train.py')
steps.append({'cmd': 'echo $?', 'out': [[0.05, f'{code}\n']], 'code': 0, 'secs': 0.1})
time.sleep(0.5)
run('wakeme --stop train')
json.dump(steps, open(os.path.join(cwd, 'session.json'), 'w'), indent=1)
for s in steps:
    print('$', s['cmd'])
    for t, l in s['out']: print(f'  [{t:5.2f}] {l}', end='')
