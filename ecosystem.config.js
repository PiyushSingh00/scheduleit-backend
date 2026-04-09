module.exports = {
  apps: [
    {
      name: "scheduleit-prod",
      script: "./app.js",
      env: {
        PORT: 4000
      }
    },
    {
      name: "scheduleit-staging",
      script: "./app.js",
      env: {
        PORT: 5000
      }
    }
  ]
};

