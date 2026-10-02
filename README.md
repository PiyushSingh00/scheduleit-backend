# ScheduleIt Backend

Express API for ScheduleIt. The app runs behind Nginx on EC2 and uses DynamoDB for application data.

## Local Checks

```bash
npm ci
npm run check
```

## Runtime

- Node.js 20 in production
- PM2 process: `scheduleit-backend`
- Default port: `4000`
- Health check: `/api/health`
- AWS region: `eu-north-1`

## Production Notes

The production EC2 instance should use an IAM instance profile with DynamoDB access. Do not store AWS access keys on the server.

Useful server commands:

```bash
pm2 list
pm2 logs scheduleit-backend --lines 100
sudo nginx -t
sudo systemctl status nginx --no-pager
curl http://127.0.0.1:4000/api/health
```

DNS for the public domain is managed outside AWS Route 53. Point the domain A records at the production Elastic IP.
