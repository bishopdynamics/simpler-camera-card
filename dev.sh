#!/usr/bin/env bash

NAME="${PWD##*/} $(uname -srm)"

echo "name: $NAME"
claude "read CLAUDE.md" --name "$NAME" --model fable
