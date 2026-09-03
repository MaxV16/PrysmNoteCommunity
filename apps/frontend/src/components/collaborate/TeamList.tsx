"use client";

import { useState } from "react";
import { TeamDetail } from "@/components/collaborate/TeamDetail";
import { useTeams } from "@/lib/teams";

export function TeamList() {
  const {
    teams,
    invites,
    loading,
    createTeam,
    renameTeam,
    deleteTeam,
    inviteMember,
    changeRole,
    removeMember,
    addProject,
    removeProject,
    acceptInvite,
    declineInvite,
  } = useTeams();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [newTeamName, setNewTeamName] = useState("");

  const handleCreate = () => {
    if (!newTeamName.trim()) return;
    void createTeam(newTeamName.trim());
    setNewTeamName("");
    setIsCreating(false);
  };

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
              if (e.key === "Enter") handleCreate();
              if (e.key === "Escape") { setIsCreating(false); setNewTeamName(""); }
            }}
            placeholder="Team name"
            className="input-field text-xs flex-1"
            autoFocus
          />
          <button
            onClick={handleCreate}
            className="btn btn-gradient text-xs px-3 py-1 rounded font-medium"
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

      {invites.length > 0 && (
        <div className="rounded-xl border border-accent/30 bg-accent/5 p-3 space-y-2">
          <h4 className="text-xs font-semibold text-secondary uppercase tracking-wider">
            Pending invites
          </h4>
          {invites.map((inv) => (
            <div key={inv.token} className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm text-primary truncate">{inv.team_name}</p>
                <p className="text-xs text-muted">as {inv.role}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => void acceptInvite(inv.token)}
                  className="btn btn-gradient text-xs px-3 py-1 rounded font-medium"
                >
                  Accept
                </button>
                <button
                  onClick={() => void declineInvite(inv.token)}
                  className="text-xs text-muted hover:text-danger transition-colors"
                >
                  Decline
                </button>
              </div>
            </div>
          ))}
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
              myRole={team.my_role || "member"}
              onClose={() => setExpandedId(null)}
              onRename={(name) => renameTeam(team.id, name)}
              onDelete={() => deleteTeam(team.id)}
              onInvite={(email) => inviteMember(team.id, email)}
              onChangeRole={(userId, role) => changeRole(team.id, userId, role)}
              onRemoveMember={(userId) => removeMember(team.id, userId)}
              onAddProject={(name) => addProject(team.id, name)}
              onRemoveProject={(projectId) => removeProject(team.id, projectId)}
            />
          )}
        </div>
      ))}

      {!loading && teams.length === 0 && invites.length === 0 && !isCreating && (
        <p className="text-xs text-muted text-center py-4">
          No teams yet. Create one to invite members and share tasks.
        </p>
      )}
    </div>
  );
}
