// A fake job for the tests: node job.mjs <mode> <seconds> [exit code]
//   chatty  print a line every 0.5 s, then exit
//   silent  print one line, then sleep without output (looks hung)
//   busy    print one line, then burn CPU without output (healthy but quiet)
import fs from 'node:fs';

const [mode, secsText, codeText, touch] = process.argv.slice(2);
const ms = Number(secsText) * 1000;
const code = Number(codeText || 0);
const end = Date.now() + ms;
const done = () => {
  if (touch) fs.writeFileSync(touch, 'result\n');
  console.log(`${mode} done`);
  process.exit(code);
};

console.log(`${mode} start`);
if (mode === 'chatty') {
  let i = 0;
  setInterval(() => { console.log(`step ${++i}`); if (Date.now() >= end) done(); }, 500);
} else if (mode === 'silent') {
  setTimeout(done, ms);
} else if (mode === 'busy') {
  const spin = () => {
    const until = Date.now() + 200;
    while (Date.now() < until) Math.sqrt(Math.random());
    if (Date.now() >= end) done(); else setImmediate(spin);
  };
  spin();
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
