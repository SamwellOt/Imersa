// Junta todos os testes (unit/ e ui/) num bundle só e roda.
import { runAll } from "./harness";

import.meta.glob(["./unit/*.test.ts", "./ui/*.test.tsx"], { eager: true });

void runAll();
