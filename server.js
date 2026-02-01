const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let rooms = {};

const createDeck = () => {
    const suits = ['♠', '♣', '♥', '♦'];
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    let deck = [];
    for (let suit of suits) {
        for (let rank of ranks) {
            deck.push({ suit, rank, id: Math.random().toString(36).substr(2, 9) });
        }
    }
    deck.push({ suit: '🃏', rank: 'Joker', id: 'Joker1' });
    return deck.sort(() => Math.random() - 0.5);
};

const calculateScore = (hand, openJokerRank) => {
    return hand.reduce((total, card) => {
        if (!card) return total;
        if (card.rank === 'Joker' || card.rank === openJokerRank) return total + 0;
        if (['J', 'Q', 'K'].includes(card.rank)) return total + 15;
        if (card.rank === 'A') return total + 1;
        return total + parseInt(card.rank);
    }, 0);
};

io.on('connection', (socket) => {
    // CREATE ROOM
    socket.on('create_room', ({ username, roundLimit }) => {
        const roomId = Math.random().toString(36).substr(2, 4).toUpperCase();
        socket.join(roomId);
        rooms[roomId] = {
            players: [{ id: socket.id, username, hand: [], totalScore: 0, eliminated: false }],
            deck: [],
            openJoker: null,
            turn: 0,
            status: 'LOBBY',
            hostId: socket.id,
            roundLimit: parseInt(roundLimit) || 5,
            currentRound: 1
        };
        socket.emit('room_created', { roomId, room: rooms[roomId] });
    });

    // JOIN ROOM
    socket.on('join_room', ({ roomId, username }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('error_msg', 'Room not found');
        if (room.status !== 'LOBBY') return socket.emit('error_msg', 'Game in progress');

        socket.join(roomId);
        room.players.push({ id: socket.id, username, hand: [], totalScore: 0, eliminated: false });
        io.to(roomId).emit('room_data', room);
    });

    // START GAME (HOST ONLY)
    socket.on('start_game', (roomId) => {
        const room = rooms[roomId];
        if (!room || room.hostId !== socket.id) return;

        room.deck = createDeck();
        room.openJoker = room.deck.pop();
        room.status = 'PLAYING';

        // Skip turn to first non-eliminated player
        room.turn = room.players.findIndex(p => !p.eliminated);

        room.players.forEach(player => {
            if (!player.eliminated) {
                player.hand = [room.deck.pop(), room.deck.pop(), room.deck.pop()];
            } else {
                player.hand = [];
            }
        });

        io.to(roomId).emit('room_data', room);
    });

    socket.on('draw_card', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.players[room.turn].id !== socket.id) return;
        const card = room.deck.pop();
        socket.emit('card_drawn', card);
    });

    socket.on('replace_card', ({ roomId, cardToDiscardId, newCard }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        player.hand = player.hand.map(c => c.id === cardToDiscardId ? newCard : c);

        // Move turn to next non-eliminated player
        let nextTurn = (room.turn + 1) % room.players.length;
        while (room.players[nextTurn].eliminated) {
            nextTurn = (nextTurn + 1) % room.players.length;
        }
        room.turn = nextTurn;

        io.to(roomId).emit('room_data', room);
    });

    socket.on('declare_show', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;

        const activePlayers = room.players.filter(p => !p.eliminated);
        const scores = activePlayers.map(p => ({
            id: p.id,
            score: calculateScore(p.hand, room.openJoker.rank)
        }));

        const callerScore = scores.find(s => s.id === socket.id).score;
        const otherScores = scores.filter(s => s.id !== socket.id).map(s => s.score);
        const minOtherScore = Math.min(...otherScores);

        if (callerScore < minOtherScore) {
            socket.emit('celebration'); // Only trigger for the winner
            room.players.forEach(p => {
                if (!p.eliminated && p.id !== socket.id) {
                    p.totalScore += calculateScore(p.hand, room.openJoker.rank);
                }
            });
        } else {
            const caller = room.players.find(p => p.id === socket.id);
            caller.totalScore += Math.max(callerScore, 25);
        }

        // ELIMINATION LOGIC
        if (room.currentRound >= room.roundLimit) {
            let highestScore = -1;
            let playerToEliminate = null;

            room.players.forEach(p => {
                if (!p.eliminated && p.totalScore > highestScore) {
                    highestScore = p.totalScore;
                    playerToEliminate = p;
                }
            });

            if (playerToEliminate) {
                playerToEliminate.eliminated = true;
                io.to(roomId).emit('player_eliminated', playerToEliminate.username);
            }
            room.currentRound = 1;
        } else {
            room.currentRound += 1;
        }

        room.status = 'LOBBY';
        io.to(roomId).emit('room_data', room);
    });

    socket.on('disconnecting', () => {
        for (const roomId of socket.rooms) {
            if (rooms[roomId]) {
                rooms[roomId].players = rooms[roomId].players.filter(p => p.id !== socket.id);
                if (rooms[roomId].players.length === 0) delete rooms[roomId];
                else io.to(roomId).emit('room_data', rooms[roomId]);
            }
        }
    });
});
const PORT = process.env.PORT || 3001;

server.listen(3001, () => console.log('Server running on port 3001'));