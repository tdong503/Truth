import React, { useState, useEffect } from "react";
import { io } from "socket.io-client";
import HiddenCard from "./HiddenCard";

const socket = io();

// 玩家列表
function PlayerList({ players, currentHostId, creatorId }) {
    return (
        <ul style={{ listStyle: "none", padding: 0 }}>
            {players.map(p => (
                <li key={p.id}>
                    {p.name}
                    {p.id === creatorId && " 👑"}  {/* 房主 */}
                    {p.id === currentHostId && " 🏅"} {/* 主持人 */}
                </li>
            ))}
        </ul>
    );
}

export default function App() {
    const [phase, setPhase] = useState("lobby");
    const [roomId, setRoomId] = useState("");
    const [name, setName] = useState("");
    const [players, setPlayers] = useState([]);
    const [role, setRole] = useState(null);
    const [wordOptions, setWordOptions] = useState([]);
    const [myWord, setMyWord] = useState(null);
    const [timer, setTimer] = useState(0);
    const [selectedVotes, setSelectedVotes] = useState([]);
    const [result, setResult] = useState(null);

    const [creatorId, setCreatorId] = useState(null);
    const [currentHostId, setCurrentHostId] = useState(null);

    // === ★ 新增：生成或获取持久化的 playerId
    const getOrCreatePlayerId = () => {
        let pid = localStorage.getItem("playerId");
        if (!pid) {
            pid = Math.random().toString(36).substr(2, 9);
            localStorage.setItem("playerId", pid);
        }
        return pid;
    };
    const playerId = getOrCreatePlayerId();

    useEffect(() => {
        socket.on("playerList", list => setPlayers(list));
        socket.on("yourRole", r => { setRole(r); setPhase("role"); });
        socket.on("wordList", ws => { setWordOptions(ws); setPhase("wordSelect"); });
        socket.on("yourWord", w => setMyWord(w));
        socket.on("discussionStart", ({ duration }) => { setPhase("discussion"); setTimer(duration); });
        socket.on("timerUpdate", t => setTimer(t));
        socket.on("discussionEnd", () => setPhase("endDiscussion"));
        socket.on("chooseKill", list => { setPlayers(list); setPhase("wolfKill"); });
        socket.on("startVote", list => { setPlayers(list); setSelectedVotes([]); setPhase("vote"); });
        socket.on("roundResult", res => { setResult(res); setPhase("result"); });
        socket.on("newHost", ({ id }) => setCurrentHostId(id));

        // === ★ 新增：页面加载/刷新时尝试恢复状态
        const savedRoomId = localStorage.getItem("roomId");
        if (savedRoomId && playerId) {
            socket.emit("reconnectPlayer", { playerId, roomId: savedRoomId });
        }
    }, []);

    // === 创建房间 ===
    const createRoom = () => {
        socket.emit(
            "createRoom",
            { name, maxPlayers: 12, duration: 60, playerId }, // ★ 传持久化playerId
            res => {
                if (res.roomId) {
                    setRoomId(res.roomId);
                    setCreatorId(res.creatorId);
                    localStorage.setItem("roomId", res.roomId); // ★ 保存房间ID
                    setPhase("waiting");
                }
            }
        );
    };

    // === 加入房间 ===
    const joinRoom = () => {
        socket.emit(
            "joinRoom",
            { roomId, name, playerId },
            res => {
                if (!res.error) {
                    setCreatorId(res.creatorId);
                    localStorage.setItem("roomId", res.roomId); // ★ 保存房间ID
                    setPhase("waiting");
                } else alert(res.error);
            }
        );
    };

    const startGame = () => socket.emit("startGame", { roomId });

    return (
        <div>
            {players.length > 0 && (
                <div>
                    <h3>房间ID: {roomId}</h3>
                    <PlayerList players={players} currentHostId={currentHostId} creatorId={creatorId} />
                </div>
            )}

            {phase === "lobby" && (
                <div>
                    <h1>狼人真言</h1>
                    <input placeholder="昵称" value={name} onChange={e => setName(e.target.value)} />
                    <button onClick={createRoom}>创建房间</button>
                    <input placeholder="房间ID" value={roomId} onChange={e => setRoomId(e.target.value)} />
                    <button onClick={joinRoom}>加入房间</button>
                </div>
            )}

            {phase === "waiting" && (
                <div>
                    {playerId === creatorId && (
                        <button onClick={startGame}>开始游戏（房主专属）</button>
                    )}
                </div>
            )}

            {phase !== "lobby" && phase !== "waiting" && (
                <div>
                    <h2>身份</h2>
                    <HiddenCard
                        text={myWord ? `${role}，词语是：${myWord}` : role}
                        cover="盖牌"
                        width={600}
                        height={50}
                    />
                </div>
            )}

            {phase === "role" && (
                <div>
                    {playerId === currentHostId && (
                        <button onClick={() => socket.emit("getWordList", { roomId })}>获取词列表（主持人专属）</button>
                    )}
                    {playerId !== currentHostId && <p>等待主持人获取词列表...</p>}
                </div>
            )}

            {phase === "wordSelect" && (
                <div>
                    <h2>选择词</h2>
                    {wordOptions.map((w, idx) => (
                        <button key={idx} onClick={() => socket.emit("selectWord", { roomId, selected: w })}>
                            {w}
                        </button>
                    ))}
                </div>
            )}

            {phase === "discussion" && (
                <div>
                    <h2>讨论中...</h2>
                    <p>剩余时间: {timer}</p>
                </div>
            )}

            {phase === "endDiscussion" && (
                <div>
                    <h2>主持人选择胜方</h2>
                    <button onClick={() => socket.emit("selectWinner", { roomId, winner: "good" })}>
                        好人胜
                    </button>
                    <button onClick={() => socket.emit("selectWinner", { roomId, winner: "wolf" })}>
                        狼人胜
                    </button>
                </div>
            )}

            {phase === "wolfKill" && (
                <div>
                    <h2>狼人击杀</h2>
                    {players.map(p => (
                        <button key={p.id} onClick={() => socket.emit("wolfKill", { roomId, targetId: p.id })}>
                            {p.name}
                        </button>
                    ))}
                </div>
            )}

            {phase === "vote" && (
                <div>
                    <h2>投票选狼（2个）</h2>
                    {players.map(p => (
                        <button
                            key={p.id}
                            onClick={() => {
                                if (selectedVotes.includes(p.id)) {
                                    setSelectedVotes(selectedVotes.filter(x => x !== p.id));
                                } else if (selectedVotes.length < 2) {
                                    setSelectedVotes([...selectedVotes, p.id]);
                                }
                            }}
                        >
                            {p.name} {selectedVotes.includes(p.id) ? "✅" : ""}
                        </button>
                    ))}
                    {selectedVotes.length === 2 && (
                        <button
                            onClick={() =>
                                socket.emit("voteWolves", { roomId, votes: selectedVotes, playerId })
                            }
                        >
                            提交
                        </button>
                    )}
                </div>
            )}

            {phase === "result" && (
                <div>
                    <h2>结果</h2>
                    <p>胜方: {result.winner === "good" ? "好人" : "狼人"}</p>
                    <p>狼得分: {result.wolfScore}</p>
                    <p>好人得分: {result.goodScore}</p>
                    <button onClick={() => setPhase("waiting")}>下一局</button>
                </div>
            )}
        </div>
    );
}