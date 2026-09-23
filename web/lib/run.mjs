import { execFile } from 'node:child_process';

/**
 * Promisified execFile. Resolves { stdout, stderr }, rejects with an Error carrying
 * .code / .killed / .stderr. Never throws synchronously.
 */
export function run(file, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { encoding: 'utf8', timeout: 8000, maxBuffer: 16 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => {
        if (err) {
          const message = (stderr || err.message || '').toString().trim() || String(err);
          const wrapped = new Error(message);
          wrapped.code = err.code;
          wrapped.killed = err.killed;
          wrapped.signal = err.signal;
          wrapped.stderr = stderr;
          wrapped.stdout = stdout;
          reject(wrapped);
          return;
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
    child.on('error', () => {
      /* handled by the callback above */
    });
  });
}
