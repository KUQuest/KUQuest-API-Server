# KUQuest API Server

Backend API for KUQuest Mobile and CMS, built with Elysia and Bun.

## Requirements

- Bun: see `.bun-version`
- Git

## Setup

```bash
git clone <repository-url>
cd KUQuest-API-Server

cp .env.example .env
bun install --frozen-lockfile
bun run dev