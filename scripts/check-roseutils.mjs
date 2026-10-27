import { pathToFileURL } from 'node:url';
import { checkRoseutilsConnection } from './roseutils-client.mjs';

export async function runRoseutilsCheck({ fetchImpl, write = line => console.log(line) } = {}) {
  const result = await checkRoseutilsConnection({ fetchImpl });
  // The client returns only an allowlisted diagnostic. Never log a raw response,
  // exception or environment; this command does not write market/status files.
  write(JSON.stringify(result, null, 2));
  return result.success ? 0 : ['TOKEN_MISSING', 'TOKEN_INVALID'].includes(result.code) ? 2 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runRoseutilsCheck();
  } catch {
    console.error('CHECK_FAILED: Diagnostyka połączenia nie została zakończona. Nie wykonano importu danych.');
    process.exitCode = 1;
  }
}
