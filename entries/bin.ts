// Binário da CLI (auto-curator). Não é entrada de API: a lista de exports não inclui este arquivo.
import { run } from "@auto-curator/cli";

process.exit(await run(process.argv.slice(2)));
