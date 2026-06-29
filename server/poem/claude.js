// Shared headless `claude -p` runner with a single-flight queue so we never
// have two CLI processes contending at once.
import { spawn } from 'node:child_process';
import { CLAUDE_BIN } from '../config.js';

// Separate single-flight lanes so a slow lane (e.g. news web-search, ~120s)
// never blocks a latency-sensitive one (e.g. poems). Calls within a lane are
// serialized; different lanes run independently.
const lanes = new Map();

// Run claude in print mode. Returns the assistant's text (parsed from JSON).
// opts: { model, systemPrompt, allowedTools (array), timeoutMs, lane }
export function runClaude(prompt, opts = {}) {
  const lane = opts.lane || 'default';
  const prev = lanes.get(lane) || Promise.resolve();
  const result = prev.then(() => _run(prompt, opts));
  // Keep this lane's chain alive regardless of success/failure.
  lanes.set(lane, result.then(() => {}, () => {}));
  return result;
}

function _run(prompt, opts) {
  const {
    model,
    systemPrompt,
    allowedTools = [],
    timeoutMs = 30000,
  } = opts;

  const args = ['-p', prompt, '--output-format', 'json'];
  if (model) args.push('--model', model);
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
  // Restrict tools explicitly. Empty array => no tools allowed.
  args.push('--allowedTools', allowedTools.join(','));
  args.push('--permission-mode', allowedTools.length ? 'acceptEdits' : 'default');

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let done = false;

    const child = spawn(CLAUDE_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill('SIGKILL');
      reject(new Error(`claude timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        const text = parsed.result ?? parsed.text ?? '';
        resolve({ text: String(text).trim(), raw: parsed });
      } catch (e) {
        // Fall back to raw stdout if it wasn't JSON.
        if (stdout.trim()) resolve({ text: stdout.trim(), raw: null });
        else reject(new Error(`claude output parse failed: ${e.message}`));
      }
    });
  });
}
