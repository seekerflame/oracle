import { WebSocketServer, WebSocket } from 'ws';

/**
 * Vibecraft Relay Server (Zero-Trust Hub)
 * 
 * This server acts as a neutral cloud relay for the Vibecraft 3D environment.
 * It simply accepts incoming WebSocket connections from both Local and Remote agents,
 * and broadcasts their JSON payloads to all other connected clients.
 * 
 * Security:
 * - NO file system access.
 * - NO execution of shell commands.
 * - Simply routes JSON messages containing X/Y coordinates, avatar states, and tool status.
 */

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

// Track connected clients
const clients = new Set();

console.log(`[Vibecraft Relay] Starting secure Hub on port ${PORT}...`);

wss.on('connection', (ws, req) => {
    // We could add authentication here (e.g., checking a shared SECRET_KEY token)
    // for now, we just accept connections to the relay.
    const ip = req.socket.remoteAddress;
    console.log(`[Vibecraft Relay] New connection from ${ip}`);
    
    clients.add(ws);

    // Tell the new client they connected successfully
    ws.send(JSON.stringify({ 
        type: 'relay_connected', 
        message: 'Successfully connected to Vibecraft Zero-Trust Hub' 
    }));

    ws.on('message', (message) => {
        try {
            // Parse message to ensure it's valid JSON
            const data = JSON.parse(message.toString());
            
            // Basic sanitization: ensuring we don't broadcast massive payloads
            if (message.length > 50000) {
                console.warn(`[Vibecraft Relay] Dropping oversized payload from ${ip}`);
                return;
            }

            // Broadcast the sanitized JSON to all OTHER clients
            for (const client of clients) {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify(data));
                }
            }
        } catch (e) {
            console.warn(`[Vibecraft Relay] Invalid JSON received from ${ip}:`, e.message);
        }
    });

    ws.on('close', () => {
        console.log(`[Vibecraft Relay] Connection closed from ${ip}`);
        clients.delete(ws);
    });
    
    ws.on('error', (err) => {
        console.error(`[Vibecraft Relay] WebSocket error from ${ip}:`, err.message);
        clients.delete(ws);
    });
});

console.log(`[Vibecraft Relay] Hub is active and listening for connections. ⛩️🏺🦅`);
