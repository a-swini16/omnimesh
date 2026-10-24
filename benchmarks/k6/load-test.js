import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 50 },  // Ramp-up to 50 virtual users
    { duration: '1m', target: 100 },  // Steady state at 100 VUs (~1,000 req/s)
    { duration: '15s', target: 0 },   // Ramp-down
  ],
  thresholds: {
    http_req_duration: ['p(95)<150', 'p(99)<300'], // 95% of requests under 150ms
    http_req_failed: ['rate<0.01'],                 // Error rate < 1%
  },
};

const BASE_URL = __ENV.TARGET_URL || 'http://localhost:3000';
const GATEWAY_SECRET = __ENV.GATEWAY_SECRET || 's3cr3t_gateway_token_min_32_characters_long_for_security';

export default function () {
  const params = {
    headers: {
      'Content-Type': 'application/json',
      'X-Gateway-Secret': GATEWAY_SECRET,
    },
  };

  // 1. Edge Cached Read Request
  const res = http.get(`${BASE_URL}/api/data`, params);
  check(res, {
    'status is 200': (r) => r.status === 200,
    'has omni node tag': (r) => r.headers['X-Omni-Node'] !== undefined,
  });

  sleep(0.1);
}
