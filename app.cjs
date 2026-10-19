// Startup file for hosting panels that run Node apps through Passenger (e.g. DirectAdmin "Node.js App").
// Passenger loads a CommonJS file, so this only hands over to the ES module server.
import('./server/dist/index.js').catch((err) => { console.error(err); process.exit(1); });
