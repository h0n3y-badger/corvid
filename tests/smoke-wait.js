// Keeps a --smoke-js session open for CDP-driven tests, then exits.
await new Promise(r => setTimeout(r, 60000));
return "done";
