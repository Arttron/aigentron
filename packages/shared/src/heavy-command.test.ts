import { describe, expect, it } from 'vitest';
import { commandWeight } from './heavy-command';

const heavy = ['pnpm build', 'npm install', 'npm ci', 'yarn', 'npm run build', 'pnpm run test:e2e', 'pnpm --filter @lds/shared build', 'npx tsc --noEmit -p .', 'tsc -p .', 'vitest run', 'npx vitest run apps', 'cargo build --release', 'go test ./...', 'docker build -t x .', 'make', 'make test', 'pytest -q', 'python -m pytest', 'pip install -r requirements.txt', 'cd app && npm run build', 'CI=1 pnpm test', 'time pnpm build', 'sudo apt-get install -y git', 'playwright test', 'git status && pnpm build', './gradlew assemble', 'pnpm prisma:generate', 'pnpm vitest run x', 'pnpm tsc', 'pnpm jest', 'bash -c "pnpm build"', "sh -c 'npm run build'", 'timeout 600 pnpm build', 'nohup pnpm build &', 'corepack pnpm build', 'yarn workspace app build', 'pnpm -w build', 'pnpm -r build', './build.sh', 'docker compose build', 'docker compose up --build', 'nice -n 10 pnpm test', 'env CI=1 pnpm build'];
const light = ['git status', 'ls -la', 'cat package.json', 'echo hi', 'node script.js', 'npm --version', 'tsc --version', 'pnpm -v', 'grep -rn foo src', 'git commit -m "build: x"', 'cargo --help', 'docker ps', 'go version', 'python script.py', 'npm run format', 'cat <<EOF\npnpm build\nEOF', 'docker compose ps', 'docker compose up -d', 'bash -c "echo hi"', 'echo "pnpm build"', 'timeout 5 ls'];
const longRunning = ['npm run dev', 'pnpm dev', 'npm start', 'vite', 'next dev', 'npm run watch', 'tsc --watch', 'vitest --watch', 'npx vite', 'npm run test:watch', 'pnpm test:watch', 'npm run build:watch', 'docker compose logs -f', 'docker compose up'];

describe('commandWeight', () => {
  it.each(heavy)('heavy: %s', (c) => expect(commandWeight(c)).toBe('heavy'));
  it.each(light)('light: %s', (c) => expect(commandWeight(c)).toBe('light'));
  it.each(longRunning)('long-running: %s', (c) => expect(commandWeight(c)).toBe('long-running'));
});
