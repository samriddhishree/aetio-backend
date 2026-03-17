# Aetio Backend (TypeScript)

## Run locally

```bash
npm install
npm run dev
```

## Build + run

```bash
npm run build
npm start
```

## Integration test

```bash
npm run test:integration
```

Set custom endpoints or payload values with:

- `AETIO_BACKEND_URL`
- `AETIO_TEST_USER_ID`
- `AETIO_TEST_OUTPUT_URL`
- `AETIO_TEST_CONTEXT_URL`

## Request

```bash
curl -X POST http://localhost:8000/generateInsights \
  -H "content-type: application/json" \
  -H "x-request-id: local" \
  -d '{
    "userId": "user-123",
    "outputUrls": ["https://example.com/report.pdf"],
    "contextUrls": ["https://example.com/overview.pdf"],
    "researchContext": "Optional project summary"
  }'
```
