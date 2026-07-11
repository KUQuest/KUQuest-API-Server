import { app } from '@/app';

const port = Number(Bun.env.PORT ?? 5000);

app.listen(port);

console.log(`KUQuest API running at http://localhost:${port}`);
