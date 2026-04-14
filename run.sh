#!/bin/bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
source ~/.bashrc

nvm use v24
node --version

cd /home/grass/relay
# Build requires TypeScript toolchain from devDependencies.
npm i --include=dev
npm run build
pm2 reload ecosystem.config.js