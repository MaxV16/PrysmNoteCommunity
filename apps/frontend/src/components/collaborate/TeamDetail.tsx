"use client";

import { useState } from "react";

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

interface TeamDetailProps {
  team: Team;
  onClose: () => void;
  onUpdate: (patch: { members?: TeamMember[]; projects?: TeamProject[]; name?: string }) => void;
  onDelete: () => void;
}

const ROLE_STYLES: Record<string, string> = {
  owner: "bg-amber-500/20 text-amber-500",
  admin: "bg-accent/20 text-accent",
  member: "bg-elevated text-secondary",
};

function generateId(): string {
  return `proj_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function TeamDetail({ team, onClose, onUpdate, onDelete }: TeamDetailProps) {
  const [inviteEmail, setInviteEmail] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState(team.name);

  const handleInvite = () => {
    if (!inviteEmail.trim()) return;
    if (team.members.some((m) => m.email === inviteEmail.trim())) {
      setInviteEmail("");
      return;
    }
    onUpdate({
      members: [...team.members, { email: inviteEmail.trim(), role: "member" }],
    });
    setInviteEmail("");
  };

  const handleRemoveMember = (email: string) => {
    onUpdate({ members: team.members.filter((m) => m.email !== email) });
  };

  const handleAddProject = () => {
    if (!newProjectName.trim()) return;
    onUpdate({
      projects: [...team.projects, { id: generateId(), name: newProjectName.trim() }],
    });
    setNewProjectName("");
    setIsAddingProject(false);
  };

  const handleRemoveProject = (projectId: string) => {
    onUpdate({ projects: team.projects.filter((p) => p.id !== projectId) });
  };

  const handleChangeRole = (email: string, role: "owner" | "admin" | "member") => {
    onUpdate({
      members: team.members.map((m) => (m.email === email ? { ...m, role } : m)),
    });
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
                if (e.key === "Enter") { onUpdate({ name: editName }); setIsEditingName(false); }
                if (e.key === "Escape") { setEditName(team.name); setIsEditingName(false); }
              }}
              className="input-field text-xs flex-1"
              autoFocus
            />
            <button
              onClick={() => { onUpdate({ name: editName }); setIsEditingName(false); }}
              className="text-xs text-accent font-medium"
            >
              Save
            </button>
          </div>
        ) : (
          <h4 className="text-sm font-semibold text-primary cursor-pointer hover:text-accent transition-colors" onClick={() => setIsEditingName(true)}>
            {team.name}
          </h4>
        )}
      </div>

      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <h5 className="text-xs font-semibold text-secondary uppercase tracking-wider">
            Members ({team.members.length})
          </h5>
        </div>
        <div className="flex flex-col gap-1.5 mb-2">
          {team.members.map((member) => (
            <div
              key={member.email}
              className="flex items-center justify-between bg-elevated rounded-lg px-2.5 py-1.5"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs text-primary truncate">{member.email}</span>
                <select
                  value={member.role}
                  onChange={(e) => handleChangeRole(member.email, e.target.value as "owner" | "admin" | "member")}
                  className={`text-[10px] font-medium rounded px-1.5 py-0.5 border-none outline-none cursor-pointer ${ROLE_STYLES[member.role]}`}
                >
                  <option value="owner">Owner</option>
                  <option value="admin">Admin</option>
                  <option value="member">Member</option>
                </select>
              </div>
              {member.role !== "owner" && (
                <button
                  onClick={() => handleRemoveMember(member.email)}
                  className="text-xs text-muted hover:text-danger transition-colors ml-1 shrink-0"
                  title="Remove member"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>

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
            className="btn bg-accent text-base text-xs px-3 py-1 rounded font-medium shrink-0"
          >
            Invite
          </button>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h5 className="text-xs font-semibold text-secondary uppercase tracking-wider">
            Shared Projects ({team.projects.length})
          </h5>
          {!isAddingProject && (
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
              className="btn bg-accent text-base text-xs px-2 py-1 rounded font-medium shrink-0"
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
                <button
                  onClick={() => handleRemoveProject(project.id)}
                  className="text-xs text-muted hover:text-danger transition-colors shrink-0"
                  title="Remove project"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted">No shared projects</p>
        )}
      </div>

      <div className="mt-4 pt-3 border-t border-border">
        <button
          onClick={onDelete}
          className="text-xs text-danger hover:underline font-medium"
        >
          Delete Team
        </button>
      </div>
    </div>
  );
}
