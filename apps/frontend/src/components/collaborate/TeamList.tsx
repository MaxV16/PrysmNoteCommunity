"use client";

import { useState, useEffect, useCallback } from "react";
import { TeamDetail } from "@/components/collaborate/TeamDetail";

interface TeamMember {
  email: string;
  role: "owner" | "admin" | "member";
}

interface TeamProject {
  id: string;
  name: string;
}

interface Team {
  id: string;
  name: string;
  members: TeamMember[];
  projects: TeamProject[];
}

const STORAGE_KEY = "prysm_collab_teams";

function generateId(): string {
  return `team_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function loadTeams(): Team[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveTeams(teams: Team[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(teams));
  } catch {}
}

export function TeamList() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [newTeamName, setNewTeamName] = useState("");

  useEffect(() => {
    setTeams(loadTeams());
  }, []);

  const persist = useCallback((updated: Team[]) => {
    setTeams(updated);
    saveTeams(updated);
  }, []);

  const createTeam = useCallback(() => {
    if (!newTeamName.trim()) return;
    const team: Team = {
      id: generateId(),
      name: newTeamName.trim(),
      members: [{ email: "you@example.com", role: "owner" }],
      projects: [],
    };
    persist([...teams, team]);
    setNewTeamName("");
    setIsCreating(false);
    setExpandedId(team.id);
  }, [newTeamName, teams, persist]);

  const updateTeam = useCallback(
    (id: string, patch: Partial<Team>) => {
      persist(teams.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    },
    [teams, persist]
  );

  const deleteTeam = useCallback(
    (id: string) => {
      persist(teams.filter((t) => t.id !== id));
      if (expandedId === id) setExpandedId(null);
    },
    [teams, persist, expandedId]
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-primary uppercase tracking-wider">Teams</h3>
        {!isCreating && (
          <button
            onClick={() => setIsCreating(true)}
            className="text-xs text-accent hover:opacity-80 font-medium"
          >
            + Create Team
          </button>
        )}
      </div>

      {isCreating && (
        <div className="card bg-surface rounded-xl p-3 flex gap-2">
          <input
            type="text"
            value={newTeamName}
            onChange={(e) => setNewTeamName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") createTeam();
              if (e.key === "Escape") { setIsCreating(false); setNewTeamName(""); }
            }}
            placeholder="Team name"
            className="input-field text-xs flex-1"
            autoFocus
          />
          <button
            onClick={createTeam}
            className="btn bg-accent text-base text-xs px-3 py-1 rounded font-medium"
          >
            Create
          </button>
          <button
            onClick={() => { setIsCreating(false); setNewTeamName(""); }}
            className="text-xs text-secondary hover:text-primary"
          >
            Cancel
          </button>
        </div>
      )}

      {teams.map((team) => (
        <div key={team.id} className="card bg-surface rounded-xl overflow-hidden">
          <button
            onClick={() => setExpandedId(expandedId === team.id ? null : team.id)}
            className="w-full p-3 flex items-center justify-between hover:bg-hover transition-colors text-left"
          >
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-accent/20 flex items-center justify-center text-accent text-xs font-bold">
                {team.name.slice(0, 2).toUpperCase()}
              </div>
              <div>
                <div className="text-sm font-medium text-primary">{team.name}</div>
                <div className="text-xs text-muted">{team.members.length} member{team.members.length !== 1 ? "s" : ""}</div>
              </div>
            </div>
            <span className={`text-xs text-muted transition-transform ${expandedId === team.id ? "rotate-90" : ""}`}>
              {"›"}
            </span>
          </button>

          {expandedId === team.id && (
            <TeamDetail
              team={team}
              onClose={() => setExpandedId(null)}
              onUpdate={(patch) => updateTeam(team.id, patch)}
              onDelete={() => deleteTeam(team.id)}
            />
          )}
        </div>
      ))}

      {teams.length === 0 && !isCreating && (
        <p className="text-xs text-muted text-center py-4">No teams yet. Create one to collaborate.</p>
      )}
    </div>
  );
}
