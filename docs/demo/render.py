# Renders session.json (a real recorded run) as an animated terminal GIF.
# Output lines appear at the times they were recorded; commands are typed out.
# To regenerate docs/demo.gif: run record.py on Linux / WSL (needs `wakeme` on PATH),
# then `python render.py ../demo.gif` with Pillow; the fonts are the Windows ones.
import json
import os
import sys
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'demo.gif')
steps = json.load(open(os.path.join(HERE, 'session.json'), encoding='utf-8'))

FONT = ImageFont.truetype(r'C:\Windows\Fonts\CascadiaMono.ttf', 14)
CAP_FONT = ImageFont.truetype(r'C:\Windows\Fonts\segoeui.ttf', 15)
CAP_BOLD = ImageFont.truetype(r'C:\Windows\Fonts\segoeuib.ttf', 15)
CW = FONT.getlength('M')
LH = 20
COLS = 96
PAD = 16
TITLE_H = 30
CAP_H = 40
ROWS = 15
W = int(PAD * 2 + CW * COLS)
H = TITLE_H + PAD + ROWS * LH + PAD // 2 + CAP_H

BG = (24, 26, 33)
TITLE_BG = (36, 39, 48)
FG = (205, 210, 220)
DIM = (120, 128, 145)
CMD = (240, 242, 246)
PROMPT = (126, 198, 153)
WAKE = (255, 203, 107)
CAP_BG = (44, 48, 62)
CAP_FG = (220, 224, 232)
ACCENT = (126, 198, 153)
DOTS = [(255, 95, 86), (255, 189, 46), (39, 201, 63)]

TYPE_MS = 45  # per character


def wrap(text):
    # wrap at spaces, like a reader would want (a real terminal breaks anywhere)
    text = text.rstrip('\n')
    lines = ['']
    for word in text.split(' '):
        candidate = f'{lines[-1]} {word}' if lines[-1] else word
        if len(candidate) <= COLS or not lines[-1]:
            lines[-1] = candidate
        else:
            lines.append(word)
    return lines


class Screen:
    def __init__(self):
        self.lines = []  # (kind, text): kind in prompt / out / wake

    def add(self, kind, text):
        for i, part in enumerate(wrap(text)):
            self.lines.append((kind if i == 0 or kind != 'prompt' else 'out', part))

    def render(self, caption, step_no, cursor=None):
        img = Image.new('RGB', (W, H), BG)
        d = ImageDraw.Draw(img)
        d.rectangle([0, 0, W, TITLE_H], fill=TITLE_BG)
        for i, c in enumerate(DOTS):
            x = 16 + i * 20
            d.ellipse([x, 10, x + 11, 21], fill=c)
        title = 'wakeme demo'
        d.text(((W - FONT.getlength(title)) / 2, 7), title, font=FONT, fill=DIM)
        rows = self.lines[-ROWS:]
        y = TITLE_H + PAD
        for kind, text in rows:
            x = PAD
            if kind == 'prompt':
                d.text((x, y), '$', font=FONT, fill=PROMPT)
                d.text((x + CW * 2, y), text, font=FONT, fill=CMD)
            else:
                d.text((x, y), text, font=FONT, fill=WAKE if kind == 'wake' else FG)
            y += LH
        if cursor is not None:
            row, col = cursor
            cy = TITLE_H + PAD + row * LH
            cx = PAD + CW * col
            d.rectangle([cx, cy + 2, cx + CW - 1, cy + LH - 3], fill=CMD)
        cap_y = H - CAP_H
        d.rectangle([0, cap_y, W, H], fill=CAP_BG)
        label = f'{step_no}' if step_no else ''
        x = PAD
        if label:
            d.ellipse([x, cap_y + 9, x + 22, cap_y + 31], fill=ACCENT)
            d.text((x + 11 - CAP_BOLD.getlength(label) / 2, cap_y + 10), label, font=CAP_BOLD, fill=BG)
            x += 32
        d.text((x, cap_y + 10), caption, font=CAP_FONT, fill=CAP_FG)
        return img


frames = []  # (image, ms)
screen = Screen()


def shot(caption, step_no, ms, cursor_at_end=False):
    cursor = None
    if cursor_at_end:
        rows = screen.lines[-ROWS:]
        kind, text = rows[-1]
        cursor = (len(rows) - 1, len(text) + (2 if kind == 'prompt' else 0))
    frames.append((screen.render(caption, step_no, cursor), ms))


def type_command(cmd, caption, step_no):
    screen.lines.append(('prompt', ''))
    shot(caption, step_no, 500, True)
    for i in range(1, len(cmd) + 1):
        screen.lines[-1] = ('prompt', cmd[:i])
        shot(caption, step_no, TYPE_MS, True)
    shot(caption, step_no, 350, True)
    # the typed line may be longer than a row: re-add it wrapped
    screen.lines.pop()
    screen.add('prompt', cmd)


def wait_with_cursor(ms, caption, step_no):
    # an idle terminal: blink the cursor on an empty last row
    screen.lines.append(('out', ''))
    left = ms
    on = True
    while left > 0:
        chunk = min(500, left)
        shot(caption, step_no, chunk, on)
        on = not on
        left -= chunk
    screen.lines.pop()


# --- step 1: start the long job under wakeme --------------------------------
run, echo, stop = steps
C1 = 'Start the long job under wakeme (the agent runs this as a background command)'
type_command(run['cmd'], C1, 1)

# replay the recorded output at its recorded times, up to the last line before the hang
t = 0.0
hang_from = None
for at, text in run['out']:
    gap = at - t
    if gap > 0.05:
        wait_with_cursor(int(gap * 1000), C1, 1)
    screen.add('out', text)
    t = at
    if text.startswith('epoch 2/3'):
        hang_from = at
        break

# --- step 2: the job hangs: count the silence up to the wake-up ---------------
wake_at = next(at for at, text in run['out'] if text.startswith('WAKEME'))
silent = wake_at - hang_from
secs = 0
while secs < int(silent):
    secs += 1
    cap = f'train.py hangs: no output for {secs}s, CPU idle'
    wait_with_cursor(1000 if secs < int(silent) else int((silent - secs + 1) * 1000), cap, 2)

# --- step 3: wakeme exits, the agent wakes ------------------------------------
for at, text in run['out']:
    if at >= wake_at:
        screen.add('wake' if text.startswith('WAKEME') else 'out', text)
C3 = 'wakeme exits with 125 (STALLED), so the waiting agent wakes up'
shot(C3, 3, 1800)
type_command(echo['cmd'], C3, 3)
for at, text in echo['out']:
    screen.add('out', text)
shot(C3, 3, 1800)

# --- step 4: the job was left running; stop it --------------------------------
C4 = 'The job was left running: --attach to keep waiting, or --stop it'
type_command(stop['cmd'], C4, 4)
wait_with_cursor(int(stop['out'][0][0] * 1000), C4, 4)
for at, text in stop['out']:
    screen.add('wake' if text.startswith('WAKEME') else 'out', text)
screen.lines.append(('prompt', ''))
shot(C4, 4, 1000, True)
shot(C4, 4, 3000, False)

# --- write the GIF with one shared palette ------------------------------------
probe = Image.new('RGB', (W, H * 2), BG)
probe.paste(frames[-1][0], (0, 0))
probe.paste(frames[len(frames) // 2][0], (0, H))
palette = probe.quantize(colors=64, method=Image.Quantize.MEDIANCUT)
images = [f.quantize(palette=palette, dither=Image.Dither.NONE) for f, _ in frames]
durations = [ms for _, ms in frames]
images[0].save(OUT, save_all=True, append_images=images[1:], duration=durations, loop=0, optimize=True, disposal=1)
print(f'{OUT}: {len(images)} frames, {sum(durations) / 1000:.1f}s, {os.path.getsize(OUT) / 1024:.0f} KB, {W}x{H}')
checks = {'hang': max(i for i in range(len(frames)) if durations[i] in (500,) and i < next(j for j in range(len(frames)) if durations[j] == 1800)),
          'wake': next(i for i in range(len(frames)) if durations[i] == 1800),
          'last': len(frames) - 1}
for name, idx in checks.items():
    frames[idx][0].save(os.path.join(HERE, f'frame-{name}.png'))
