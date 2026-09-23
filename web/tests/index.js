// Entry point so that `node --test tests/` works on Node 24, which resolves a
// directory positional through normal module resolution instead of expanding it.
// `node --test` (auto-discovery) and `node --test tests/*.test.mjs` work too.
import './server.test.mjs';
import './config.test.mjs';
import './api.test.mjs';
import './transcript.test.mjs';
import './markdown.test.mjs';
import './spawn.test.mjs';
import './kill.test.mjs';
import './autoname.test.mjs';
import './snapshot.test.mjs';
import './ui.test.mjs';
