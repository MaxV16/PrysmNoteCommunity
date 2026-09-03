"use client";

import { useState } from "react";
import type { Team } from "@/lib/teams";

const ROLE_STYLES: Record<string, string> = {
  owner: "bg-amber-500/20 text-amber-500",
  admin: "bg-accent/20 text-accent",
  member: "bg-elevated text-secondary",
};

interface TeamDetailProps {
  team: Team;
  myRole: string;
  onClose: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onInvite: (email: string) => void;
  onChangeRole: (userId: string, role: string) => void;
  onRemoveMember: (userId: string) => void;
  onAddProject: (name: string) => void;
  onRemoveProject: (projectId: string) => void;
}

export function TeamDetail({
  team,
  myRole,
  onClose,
  onRename,
  onDelete,
  onInvite,
  onChangeRole,
  onRemoveMember,
  onAddProject,
  onRemoveProject,
}: TeamDetailProps) {
  const [inviteEmail, setInviteEmail] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState(team.name);
  const [inviteMsg, setInviteMsg] = useState<string | null>(null);

  const canManage = myRole === "owner" || myRole === "admin";

  const handleInvite = () => {
    if (!inviteEmail.trim()) return;
    if (team.members.some((m) => (m.email || "").toLowerCase() === inviteEmail.trim().toLowerCase())) {
      setInviteEmail("");
      return;
    }
    void onInvite(inviteEmail.trim());
    setInviteEmail("");
    setInviteMsg(`Invite sent to ${inviteEmail.trim()}.`);
    setTimeout(() => setInviteMsg(null), 2500);
  };

  const handleAddProject = () => {
    if (!newProjectName.trim()) return;
    void onAddProject(newProjectName.trim());
    setNewProjectName("");
    setIsAddingProject(false);
  };

  return (
    <div className="border-t border-border p-3">
      <div className="flex items-center justify-between mb-3">
        {isEditingName ? (
          <div className="flex items-center gap-1 flex-1">
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { void onRename(editName); setIsEditingName(false); }
                if (e.key === "Escape") { setEditName(team.name); setIsEditingName(false); }
              }}
              className="input-field text-xs flex-1"
              autoFocus
            />
            <button
              onClick={() => { void onRename(editName); setIsEditingName(false); }}
              className="text-xs text-accent font-medium"
            >
              Save
            </button>
          </div>
        ) : (
          <h4
            className={`text-sm font-semibold text-primary ${canManage ? "cursor-pointer hover:text-accent transition-colors" : ""}`}
            onClick={() => canManage && setIsEditingName(true)}
          >
            {team.name}
          </h4>
        )}
      </div>

      {inviteMsg && (
        <div className="mb-3 rounded-lg bg-success/10 border border-success/20 px-3 py-1.5 text-xs text-success">
          {inviteMsg}
        </div>
      )}

      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <h5 className="text-xs font-semibold text-secondary uppercase tracking-wider">
            Members ({team.members.length})
          </h5>
        </div>
        <div className="flex flex-col gap-1.5 mb-2">
          {team.members.map((member) => (
            <div
              key={member.user_id}
              className="flex items-center justify-between bg-elevated rounded-lg px-2.5 py-1.5"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs text-primary truncate">{member.email || "…"}</span>
                <select
                  value={member.role}
                  disabled={!canManage}
                  onChange={(e) => onChangeRole(member.user_id, e.target.value)}
                  className={`text-[10px] font-medium rounded px-1.5 py-0.5 border-none outline-none cursor-pointer ${canManage ? "cursor-pointer" : "cursor-not-allowed"} ${ROLE_STYLES[member.role]}`}
                >
                  <option value="owner">Owner</option>
                  <option value="admin">Admin</option>
                  <option value="member">Member</option>
                </select>
              </div>
              {member.role !== "owner" && canManage && (
                <button
                  onClick={() => onRemoveMember(member.user_id)}
                  className="text-xs text-muted hover:text-danger transition-colors ml-1 shrink-0"
                  title="Remove member"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>

        {canManage && (
          <div className="flex gap-1.5">
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleInvite(); }}
              placeholder="email@example.com"
              className="input-field text-xs flex-1"
            />
            <button
              onClick={handleInvite}
              className="btn btn-gradient text-xs px-3 py-1 rounded font-medium shrink-0"
            >
              Invite
            </button>
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h5 className="text-xs font-semibold text-secondary uppercase tracking-wider">
            Shared Projects ({team.projects.length})
          </h5>
          {canManage && !isAddingProject && (
            <button
              onClick={() => setIsAddingProject(true)}
              className="text-xs text-accent hover:opacity-80 font-medium"
            >
              + Add
            </button>
          )}
        </div>

        {isAddingProject && (
          <div className="flex gap-1.5 mb-2">
            <input
              type="text"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAddProject();
                if (e.key === "Escape") { setIsAddingProject(false); setNewProjectName(""); }
              }}
              placeholder="Project name"
              className="input-field text-xs flex-1"
              autoFocus
            />
            <button
              onClick={handleAddProject}
              className="btn btn-gradient text-xs px-2 py-1 rounded font-medium shrink-0"
            >
              Add
            </button>
          </div>
        )}

        {team.projects.length > 0 ? (
          <div className="flex flex-col gap-1">
            {team.projects.map((project) => (
              <div
                key={project.id}
                className="flex items-center justify-between bg-elevated rounded-lg px-2.5 py-1.5"
              >
                <div className="flex items-center gap-1.5">
                  <div className="h-1.5 w-1.5 rounded-full bg-accent shrink-0" />
                  <span className="text-xs text-primary">{project.name}</span>
                </div>
                {canManage && (
                  <button
                    onClick={() => onRemoveProject(project.id)}
                    className="text-xs text-muted hover:text-danger transition-colors shrink-0"
                    title="Remove project"
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted">No shared projects</p>
        )}
      </div>

      {myRole === "owner" && (
        <div className="mt-4 pt-3 border-t border-border">
          <button
            onClick={() => { if (window.confirm("Delete this team?")) onDelete(); }}
            className="text-xs text-danger hover:underline font-medium"
          >
            Delete Team
          </button>
        </div>
      )}
    </div>
  );
}
