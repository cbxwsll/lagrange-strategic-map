module.exports = {
  apps: [{
    name: 'lagrange-strategic-map',
    script: 'src/index.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '250M',
    env: {
      NODE_ENV: 'production',
      PORT: 9200
    }
  }]
};
