const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let rooms = {};

// Helper: Create a fresh shuffled deck
const createDeck = () => {
    const suits = ['♠', '♣', '♥', '♦'];
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    let deck = [];
    for (let suit of suits) {
        for (let rank of ranks) {
            deck.push({ suit, rank, id: Math.random().toString(36).substr(2, 9) });
        }
    }
    // Add two Jokers
    deck.push({ suit: '🃏', rank: 'Joker', id: 'Joker1' });
    deck.push({ suit: '🃏', rank: 'Joker', id: 'Joker2' });
    return deck.sort(() => Math.random() - 0.5);
};

// Helper: Calculate points in hand
const calculateScore = (hand, openJokerRank) => {
    return hand.reduce((total, card) => {
        if (!card) return total;
        // Joker card or any card matching the Open Joker rank is 0 points
        if (card.rank === 'Joker' || card.rank === openJokerRank) return total + 0;
        if (['J', 'Q', 'K'].includes(card.rank)) return total + 10;
        if (card.rank === 'A') return total + 1;
        return total + parseInt(card.rank);
    }, 0);
};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // CREATE ROOM
    socket.on('create_room', ({ username, roundLimit }) => {
        const roomId = Math.random().toString(36).substr(2, 4).toUpperCase();
        const room = {
            roomId,
            players: [{
                id: socket.id,
                username,
                hand: [],
                totalScore: 0,
                eliminated: false,
                currentDrawnCard: null
            }],
            deck: [],
            openJoker: null,
            turn: 0,
            status: 'LOBBY',
            hostId: socket.id,
            roundLimit: parseInt(roundLimit) || 5,
            currentRound: 1
        };
        rooms[roomId] = room;
        socket.join(roomId);
        socket.emit('room_data', room);
    });

    // JOIN ROOM
    socket.on('join_room', ({ roomId, username }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('error_msg', 'Room not found');
        if (room.status !== 'LOBBY' && room.status !== 'WINNER') return socket.emit('error_msg', 'Game in progress');

        socket.join(roomId);
        room.players.push({
            id: socket.id,
            username,
            hand: [],
            totalScore: 0,
            eliminated: false,
            currentDrawnCard: null
        });
        io.to(roomId).emit('room_data', room);
    });

    // START GAME / NEXT ROUND
    socket.on('start_game', (roomId) => {
        const room = rooms[roomId];
        if (!room || room.hostId !== socket.id) return;

        room.deck = createDeck();
        room.openJoker = room.deck.pop();
        room.status = 'PLAYING';

        room.players.forEach(player => {
            player.currentDrawnCard = null;
            if (!player.eliminated) {
                player.hand = [room.deck.pop(), room.deck.pop(), room.deck.pop()];
            } else {
                player.hand = [];
            }
        });

        // Set turn to the first non-eliminated player
        room.turn = room.players.findIndex(p => !p.eliminated);
        io.to(roomId).emit('room_data', room);
    });

    // DRAW CARD
    socket.on('draw_card', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.players[room.turn].id !== socket.id) return;

        if (room.deck.length === 0) room.deck = createDeck();

        const card = room.deck.pop();
        const player = room.players.find(p => p.id === socket.id);
        player.currentDrawnCard = card;

        io.to(roomId).emit('room_data', room);
    });

    // REPLACE CARD AND END TURN
    socket.on('replace_card', ({ roomId, cardToDiscardId }) => {
        const room = rooms[roomId];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.currentDrawnCard) return;

        // Swap the card in hand
        player.hand = player.hand.map(c => c.id === cardToDiscardId ? player.currentDrawnCard : c);
        player.currentDrawnCard = null;

        // Pass turn to next active player
        let nextTurn = (room.turn + 1) % room.players.length;
        let attempts = 0;
        while (room.players[nextTurn].eliminated && attempts < room.players.length) {
            nextTurn = (nextTurn + 1) % room.players.length;
            attempts++;
        }
        room.turn = nextTurn;

        io.to(roomId).emit('room_data', room);
    });

    // DECLARE SHOW (The core "Bluff" mechanic)
    socket.on('declare_show', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;

        const activePlayers = room.players.filter(p => !p.eliminated);
        const scores = activePlayers.map(p => ({
            id: p.id,
            score: calculateScore(p.hand, room.openJoker.rank)
        }));

        const caller = room.players.find(p => p.id === socket.id);
        const callerScore = scores.find(s => s.id === socket.id).score;
        const otherScores = scores.filter(s => s.id !== socket.id).map(s => s.score);
        const minOtherScore = Math.min(...otherScores);

        if (callerScore < minOtherScore) {
            // CASE 1: SUCCESSFUL SHOW (Caller has lowest points)
            socket.emit('celebration'); // Only the winner gets confetti
            room.players.forEach(p => {
                if (!p.eliminated && p.id !== socket.id) {
                    p.totalScore += calculateScore(p.hand, room.openJoker.rank);
                }
            });
        } else {
            // CASE 2: FAILED BLUFF (Someone else has equal or fewer points)
            caller.totalScore += (callerScore + 25); // Penalty points
            socket.emit('penalty'); // Trigger Red Flash/Shake on caller's screen
        }

        // Handle Round Counter and Elimination
        if (room.currentRound >= room.roundLimit) {
            let active = room.players.filter(p => !p.eliminated);
            let highestScore = Math.max(...active.map(p => p.totalScore));

            // Eliminate players with the highest score
            room.players.forEach(p => {
                if (!p.eliminated && p.totalScore === highestScore) {
                    p.eliminated = true;
                }
            });
            room.currentRound = 1; // Reset rounds for next elimination cycle
        } else {
            room.currentRound += 1;
        }

        // Check if only one player is left
        const remainingPlayers = room.players.filter(p => !p.eliminated);
        if (remainingPlayers.length <= 1) {
            room.status = 'WINNER';
        } else {
            room.status = 'LOBBY'; // Go back to lobby for next round deal
        }

        io.to(roomId).emit('room_data', room);
    });

    // DISCONNECT
    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);

            if (playerIndex !== -1) {
                room.players.splice(playerIndex, 1);
                if (room.hostId === socket.id && room.players.length > 0) {
                    room.hostId = room.players[0].id;
                }
                if (room.players.length === 0) {
                    delete rooms[roomId];
                } else {
                    io.to(roomId).emit('room_data', room);
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));