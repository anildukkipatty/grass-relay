require("dotenv").config();

module.exports = {
  apps: [
    {
      name: "grass-relay",
      script: "./dist/index.js",
      autorestart: true,
      watch: false,
      max_memory_restart: "4G",
    },
  ],
  deploy: {
    prod: {
      user: process.env.DEPLOY_USER,
      host: process.env.DEPLOY_HOST,
      ref: process.env.DEPLOY_REF,
      repo: "git@github.com:anildukkipatty/grass-relay.git",
      path: process.env.DEPLOY_PATH,
      "post-deploy": "bash run.sh",
    }
  },
};
