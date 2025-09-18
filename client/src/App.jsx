import React, { useState, useEffect } from "react";
import { io } from "socket.io-client";
import HiddenCard from "./HiddenCard";

const socket = io();

function PlayerList({ players, currentHostId, creatorId }) {
    return (
        <ul style={{ listStyle: "none", padding: 0 }}>
            {players.map((p) => (
                <li key={p.id}>
                    {p.name}
                    {p.id === creatorId && "(房主 👑)"}
                    {p.id === currentHostId && "(主持人 🏅)"}
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
    const [playerId, setPlayerId] = useState(null);

    const [killTargets, setKillTargets] = useState(null);
    const [isSubmitting, setIsSubmitting] = useState(false);

    // 新增：主持人自定义词
    const [customWord, setCustomWord] = useState("");

    useEffect(() => {
        socket.on("playerList", (list) => setPlayers(list));
        socket.on("yourRole", (r) => {
            setRole(r);
            setMyWord(null);
            setPhase("role");
        });
        socket.on("wordList", (ws) => {
            setWordOptions(ws);
            setPhase("wordSelect");
        });
        socket.on("yourWord", (w) => setMyWord(w));
        socket.on("discussionStart", ({ duration }) => {
            setPhase("discussion");
            setTimer(duration);
        });
        socket.on("timerUpdate", (t) => setTimer(t));
        socket.on("discussionEnd", () => setPhase("endDiscussion"));
        socket.on("chooseKill", (list) => {
            setPlayers(list);
            setPhase("wolfKill");
        });
        socket.on("startVote", (list) => {
            setPlayers(list);
            setSelectedVotes([]);
            setPhase("vote");
        });
        socket.on("roundResult", (res) => {
            setResult(res);
            setPhase("result");
        });
        socket.on("newHost", ({ id }) => setCurrentHostId(id));
        socket.on("killTargetList", (list) => {
            setKillTargets(list);
            setPhase("wolfKill");
        });
        socket.on("errorMessage", (msg) => {
            alert(msg);
        });
    }, []);

    useEffect(() => {
        const savedRoomId = localStorage.getItem("roomId");
        const savedPlayerId = localStorage.getItem("playerId");

        if (savedRoomId && savedPlayerId) {
            socket.emit(
                "reconnectPlayer",
                { roomId: savedRoomId, playerId: savedPlayerId },
                (res) => {
                    if (res.success) {
                        setRoomId(res.roomId);
                        setCreatorId(res.creatorId);
                        setCurrentHostId(res.currentHostId);
                        setPlayers(res.players);
                        setPhase(res.phase || "waiting");
                        setTimer(res.timer || 0);
                        setPlayerId(savedPlayerId);
                        setRole(res.myRole || null);
                        setMyWord(res.myWord || null);
                        setWordOptions(res.wordOptions || []);
                        setSelectedVotes(res.selectedVotes || []);
                        if (res.phase === "result" && res.result) setResult(res.result);
                    } else {
                        localStorage.removeItem("roomId");
                        localStorage.removeItem("playerId");
                    }
                }
            );
        }
    }, []);

    const createRoom = () => {
        socket.emit(
            "createRoom",
            { name, maxPlayers: 12, duration: 60 },
            (res) => {
                setRoomId(res.roomId);
                setCreatorId(res.creatorId);
                setPlayerId(res.playerId);
                localStorage.setItem("roomId", res.roomId);
                localStorage.setItem("playerId", res.playerId);
            }
        );
        setPhase("waiting");
    };

    const joinRoom = () => {
        socket.emit("joinRoom", { roomId, name }, (res) => {
            if (!res.error) {
                setCreatorId(res.creatorId);
                setPlayerId(res.playerId);
                localStorage.setItem("roomId", res.roomId);
                localStorage.setItem("playerId", res.playerId);
                setPhase("waiting");
            } else alert(res.error);
        });
    };

    const startGame = () => {
        if (players.length < 4) {
            alert("人数不足，至少需要 4 名玩家才能开始游戏");
            return;
        }
        setKillTargets(null); // 清除上一局的击杀目标
        socket.emit("startGame", { roomId });
    };

    return (
        <div>
            {players.length > 0 && (
                <div>
                    <h3>房间ID: {roomId}</h3>
                    <PlayerList
                        players={players}
                        currentHostId={currentHostId}
                        creatorId={creatorId}
                    />
                </div>
            )}

            {phase === "lobby" && (
                <div>
                    <h1>狼人真言</h1>
                    <input
                        placeholder="昵称"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                    />
                    <button onClick={createRoom}>创建房间</button>
                    <input
                        placeholder="房间ID"
                        value={roomId}
                        onChange={(e) => setRoomId(e.target.value)}
                    />
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
                        <button onClick={() => socket.emit("getWordList", { roomId })}>
                            获取词列表（主持人专属）
                        </button>
                    )}
                    {playerId !== currentHostId && <p>等待主持人获取词列表...</p>}
                </div>
            )}

            {phase === "wordSelect" && (
                <div>
                    <h2>选择词</h2>
                    {wordOptions.map((w, idx) => (
                        <button
                            key={idx}
                            onClick={() => socket.emit("selectWord", { roomId, selected: w })}
                        >
                            {w}
                        </button>
                    ))}

                    {playerId === currentHostId && (
                        <div style={{ marginTop: "10px" }}>
                            <input
                                type="text"
                                placeholder="自定义词语"
                                value={customWord}
                                onChange={(e) => setCustomWord(e.target.value)}
                            />
                            <button
                                onClick={() => {
                                    if (customWord.trim()) {
                                        socket.emit("selectWord", {
                                            roomId,
                                            selected: customWord.trim()
                                        });
                                        setCustomWord("");
                                    }
                                }}
                            >
                                提交自定义词
                            </button>
                        </div>
                    )}
                </div>
            )}

            {phase === "discussion" && (
                <div>
                    <h2>讨论中...</h2>
                    <p>剩余时间: {timer}</p>
                    {playerId === currentHostId && (
                        <button
                            onClick={() => {
                                if (window.confirm("确定要提前结束并进入狼人击杀阶段吗？")) {
                                    socket.emit("forceEndDiscussion", { roomId });
                                }
                            }}
                        >
                            提前结束讨论
                        </button>
                    )}
                </div>
            )}

            {phase === "endDiscussion" && playerId === currentHostId && (
                <div>
                    <h2>是否猜到词语</h2>
                    <button
                        onClick={() =>
                            socket.emit("selectWinner", { roomId, winner: "good" })
                        }
                    >
                        是
                    </button>
                    <button
                        onClick={() =>
                            socket.emit("selectWinner", { roomId, winner: "wolf" })
                        }
                    >
                        否
                    </button>
                </div>
            )}

            {phase === "wolfKill" && (
                <div>
                    <h2>狼人击杀</h2>
                    {(killTargets || []).map((p) => (
                        <button
                            key={p.id}
                            onClick={() =>
                                socket.emit("wolfKill", { roomId, targetId: p.id })
                            }
                        >
                            {p.name}
                        </button>
                    ))}
                </div>
            )}

            {phase === "vote" && (
                <div>
                    <h2>全民投票（每人选1个玩家）</h2>
                    {players.map((p) => (
                        <button
                            key={p.id}
                            onClick={() => setSelectedVotes([p.id])}
                        >
                            {p.name} {selectedVotes.includes(p.id) ? "✅" : ""}
                        </button>
                    ))}
                    {selectedVotes.length === 1 && (
                        <button
                            disabled={isSubmitting}
                            onClick={() => {
                                setIsSubmitting(true);
                                socket.emit("voteWolves", { roomId, votes: selectedVotes });
                            }}
                        >
                            提交
                        </button>
                    )}
                </div>
            )}

            {phase === "result" && result && (
                <div>
                    <h2>结果</h2>
                    <p>胜方: {result.winner === "good" ? "好人" : "狼人"}</p>
                    <p>预言家: {result.seerName}</p>
                    <p>狼人: {result.wolfNames?.join(", ")}</p>

                    {result.votesRecord && Object.keys(result.votesRecord).length > 0 && (
                        <div>
                            <h3>投票结果:</h3>
                            <ul>
                                {Object.entries(result.votesRecord).map(([voter, target]) => (
                                    <li key={voter}>{voter} → {target}</li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {result.voteCountsSorted && result.voteCountsSorted.length > 0 && (
                        <div>
                            <h3>票数排行:</h3>
                            <ul>
                                {result.voteCountsSorted.map((p, idx) => (
                                    <li key={idx}>
                                        {p.name} — {p.count} 票
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {playerId === currentHostId && (
                        <button onClick={startGame}>
                            重新开局
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}