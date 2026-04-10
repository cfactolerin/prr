#!/usr/bin/env bash
set -euo pipefail

echo "Building universal macOS binary..."

export MACOSX_DEPLOYMENT_TARGET=12.0

cargo build --release --target x86_64-apple-darwin
cargo build --release --target aarch64-apple-darwin

mkdir -p bin

lipo -create \
  target/x86_64-apple-darwin/release/prr \
  target/aarch64-apple-darwin/release/prr \
  -output bin/prr-darwin-universal

chmod +x bin/prr-darwin-universal

echo "Built: bin/prr-darwin-universal"
file bin/prr-darwin-universal
