const securityHeaders = [
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
];

export default {
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
  webpack: (config, { isServer }) => {
    if (!isServer) config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false, os: false };
    return config;
  },
};
