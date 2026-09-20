const { createApp } = require('./app');
const port = process.env.PORT || 3000;
createApp().listen(port, () => console.log(`AI Project Planner running at http://localhost:${port}`));
