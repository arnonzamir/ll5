"use client";

import { useState, useEffect, useTransition, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Users,
  Plus,
  Pencil,
  KeyRound,
  Ban,
  CheckCircle,
  Home,
  UserPlus,
  UserMinus,
  RefreshCw,
} from "lucide-react";
import {
  fetchUsers,
  createUser,
  updateUser,
  resetPin,
  disableUser,
  enableUser,
  fetchFamilies,
  createFamily,
  addFamilyMember,
  removeFamilyMember,
  type User,
  type Family,
} from "./users-server-actions";

// --- Error Banner ---

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
      <span>{message}</span>
      <button onClick={onDismiss} className="text-red-400 hover:text-red-600 cursor-pointer">
        Dismiss
      </button>
    </div>
  );
}

// --- Create / Edit User Dialog ---

function UserFormDialog({
  open,
  onOpenChange,
  editingUser,
  onSave,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingUser: User | null;
  onSave: (data: {
    username: string;
    display_name: string;
    pin?: string;
    role: string;
    timezone: string;
  }) => void;
  isPending: boolean;
}) {
  const isEdit = !!editingUser;

  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [role, setRole] = useState("user");
  const [timezone, setTimezone] = useState("Asia/Jerusalem");
  const [validationError, setValidationError] = useState("");

  useEffect(() => {
    if (open) {
      if (editingUser) {
        setUsername(editingUser.username ?? "");
        setDisplayName(editingUser.display_name ?? "");
        setRole(editingUser.role ?? "user");
        setTimezone(editingUser.timezone ?? "Asia/Jerusalem");
        setPin("");
        setPinConfirm("");
      } else {
        setUsername("");
        setDisplayName("");
        setPin("");
        setPinConfirm("");
        setRole("user");
        setTimezone("Asia/Jerusalem");
      }
      setValidationError("");
    }
  }, [open, editingUser]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setValidationError("");

    if (!username.trim()) {
      setValidationError("Username is required");
      return;
    }

    if (!isEdit) {
      if (!pin) {
        setValidationError("PIN is required for new users");
        return;
      }
      if (pin !== pinConfirm) {
        setValidationError("PINs do not match");
        return;
      }
      if (pin.length < 4) {
        setValidationError("PIN must be at least 4 characters");
        return;
      }
    }

    onSave({
      username: username.trim(),
      display_name: displayName.trim(),
      ...(isEdit ? {} : { pin }),
      role,
      timezone: timezone.trim() || "Asia/Jerusalem",
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit User" : "Create User"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update user details. PIN cannot be changed here."
              : "Create a new user account."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {validationError && (
            <p className="text-sm text-red-600">{validationError}</p>
          )}

          <div className="space-y-2">
            <Label htmlFor="username">Username *</Label>
            <Input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. john"
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="display_name">Display Name</Label>
            <Input
              id="display_name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. John Doe"
            />
          </div>

          {!isEdit && (
            <>
              <div className="space-y-2">
                <Label htmlFor="pin">PIN *</Label>
                <Input
                  id="pin"
                  type="password"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  placeholder="At least 4 characters"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pin_confirm">Confirm PIN *</Label>
                <Input
                  id="pin_confirm"
                  type="password"
                  value={pinConfirm}
                  onChange={(e) => setPinConfirm(e.target.value)}
                  placeholder="Re-enter PIN"
                />
              </div>
            </>
          )}

          <div className="space-y-2">
            <Label htmlFor="role">Role</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">User</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="timezone">Timezone</Label>
            <Input
              id="timezone"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="e.g. Asia/Jerusalem"
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Saving..." : isEdit ? "Save Changes" : "Create User"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Reset PIN Dialog ---

function ResetPinDialog({
  open,
  onOpenChange,
  user,
  onReset,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: User | null;
  onReset: (userId: string, pin: string) => void;
  isPending: boolean;
}) {
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [validationError, setValidationError] = useState("");

  useEffect(() => {
    if (open) {
      setPin("");
      setPinConfirm("");
      setValidationError("");
    }
  }, [open]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setValidationError("");

    if (!pin || pin.length < 4) {
      setValidationError("PIN must be at least 4 characters");
      return;
    }
    if (pin !== pinConfirm) {
      setValidationError("PINs do not match");
      return;
    }

    onReset(user.id, pin);
  }

  if (!user) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset PIN</DialogTitle>
          <DialogDescription>
            Set a new PIN for {user.display_name || user.username || user.id}.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {validationError && (
            <p className="text-sm text-red-600">{validationError}</p>
          )}

          <div className="space-y-2">
            <Label htmlFor="new_pin">New PIN</Label>
            <Input
              id="new_pin"
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="At least 4 characters"
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new_pin_confirm">Confirm New PIN</Label>
            <Input
              id="new_pin_confirm"
              type="password"
              value={pinConfirm}
              onChange={(e) => setPinConfirm(e.target.value)}
              placeholder="Re-enter PIN"
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Resetting..." : "Reset PIN"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Create Family Dialog ---

function CreateFamilyDialog({
  open,
  onOpenChange,
  onCreate,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string) => void;
  isPending: boolean;
}) {
  const [name, setName] = useState("");

  useEffect(() => {
    if (open) setName("");
  }, [open]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    onCreate(name.trim());
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Family</DialogTitle>
          <DialogDescription>Create a new family group.</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="family_name">Family Name</Label>
            <Input
              id="family_name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Zamir Family"
              autoFocus
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending || !name.trim()}>
              {isPending ? "Creating..." : "Create Family"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Add Member Dialog ---

function AddMemberDialog({
  open,
  onOpenChange,
  familyId,
  users,
  existingMemberIds,
  onAdd,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  familyId: string | null;
  users: User[];
  existingMemberIds: string[];
  onAdd: (familyId: string, userId: string, role: string) => void;
  isPending: boolean;
}) {
  const [selectedUserId, setSelectedUserId] = useState("");
  const [memberRole, setMemberRole] = useState("member");

  useEffect(() => {
    if (open) {
      setSelectedUserId("");
      setMemberRole("member");
    }
  }, [open]);

  const availableUsers = users.filter(
    (u) => !existingMemberIds.includes(u.id)
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!familyId || !selectedUserId) return;
    onAdd(familyId, selectedUserId, memberRole);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Family Member</DialogTitle>
          <DialogDescription>
            Add an existing user to this family.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>User</Label>
            <Select value={selectedUserId} onValueChange={setSelectedUserId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a user..." />
              </SelectTrigger>
              <SelectContent>
                {availableUsers.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.display_name || u.username || u.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {availableUsers.length === 0 && (
              <p className="text-xs text-gray-400">
                All users are already members of this family.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Role in Family</Label>
            <Select value={memberRole} onValueChange={setMemberRole}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="parent">Parent</SelectItem>
                <SelectItem value="child">Child</SelectItem>
                <SelectItem value="member">Member</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isPending || !selectedUserId}
            >
              {isPending ? "Adding..." : "Add Member"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- User Row ---

function UserRow({
  user,
  onEdit,
  onResetPin,
  onToggleEnabled,
  isPending,
}: {
  user: User;
  onEdit: (user: User) => void;
  onResetPin: (user: User) => void;
  onToggleEnabled: (user: User) => void;
  isPending: boolean;
}) {
  return (
    <tr className="border-b border-gray-100 last:border-0">
      <td className="py-2.5 pr-3">
        <span className="text-sm font-medium">
          {user.username ?? <span className="text-gray-400 italic">none</span>}
        </span>
      </td>
      <td className="py-2.5 pr-3">
        <span className="text-sm text-gray-600">
          {user.display_name ?? <span className="text-gray-300">--</span>}
        </span>
      </td>
      <td className="py-2.5 pr-3">
        <Badge variant={user.role === "admin" ? "default" : "secondary"}>
          {user.role}
        </Badge>
      </td>
      <td className="py-2.5 pr-3">
        <Badge variant={user.enabled ? "success" : "destructive"}>
          {user.enabled ? "Enabled" : "Disabled"}
        </Badge>
      </td>
      <td className="py-2.5 pr-3">
        <span className="text-xs text-gray-400">
          {user.created_at
            ? new Date(user.created_at).toLocaleDateString()
            : "--"}
        </span>
      </td>
      <td className="py-2.5 text-right">
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onEdit(user)}
            disabled={isPending}
            className="h-7 px-2 text-xs"
          >
            <Pencil className="h-3 w-3 mr-1" />
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onResetPin(user)}
            disabled={isPending}
            className="h-7 px-2 text-xs"
          >
            <KeyRound className="h-3 w-3 mr-1" />
            PIN
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onToggleEnabled(user)}
            disabled={isPending}
            className={`h-7 px-2 text-xs ${
              user.enabled
                ? "text-red-600 hover:text-red-700 hover:bg-red-50"
                : "text-green-600 hover:text-green-700 hover:bg-green-50"
            }`}
          >
            {user.enabled ? (
              <>
                <Ban className="h-3 w-3 mr-1" />
                Disable
              </>
            ) : (
              <>
                <CheckCircle className="h-3 w-3 mr-1" />
                Enable
              </>
            )}
          </Button>
        </div>
      </td>
    </tr>
  );
}

// --- Family Card ---

function FamilyCard({
  family,
  onAddMember,
  onRemoveMember,
  isPending,
}: {
  family: Family;
  onAddMember: (familyId: string) => void;
  onRemoveMember: (familyId: string, userId: string) => void;
  isPending: boolean;
}) {
  const FAMILY_ROLE_COLORS: Record<string, { variant: "default" | "secondary" | "outline" | "success" | "warning" }> = {
    parent: { variant: "default" },
    child: { variant: "warning" },
    member: { variant: "secondary" },
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Home className="h-4 w-4 text-gray-400" />
            <span>{family.name}</span>
            <Badge variant="secondary" className="text-xs">
              {family.members.length} member{family.members.length !== 1 ? "s" : ""}
            </Badge>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onAddMember(family.id)}
            disabled={isPending}
            className="h-7 text-xs"
          >
            <UserPlus className="h-3 w-3 mr-1" />
            Add Member
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {family.members.length === 0 ? (
          <p className="text-sm text-gray-400">No members yet.</p>
        ) : (
          <div className="space-y-2">
            {family.members.map((member) => (
              <div
                key={member.user_id}
                className="flex items-center justify-between py-1.5 border-b border-gray-50 last:border-0"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">
                    {member.display_name || member.username || member.user_id}
                  </span>
                  <Badge
                    variant={
                      FAMILY_ROLE_COLORS[member.role]?.variant ?? "secondary"
                    }
                    className="text-xs"
                  >
                    {member.role}
                  </Badge>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onRemoveMember(family.id, member.user_id)}
                  disabled={isPending}
                  className="h-7 px-2 text-xs text-red-600 hover:text-red-700 hover:bg-red-50"
                >
                  <UserMinus className="h-3 w-3 mr-1" />
                  Remove
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// --- Main View ---

export function UsersView() {
  const [users, setUsers] = useState<User[]>([]);
  const [families, setFamilies] = useState<Family[]>([]);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // User form dialog
  const [userDialogOpen, setUserDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);

  // Reset PIN dialog
  const [pinDialogOpen, setPinDialogOpen] = useState(false);
  const [pinUser, setPinUser] = useState<User | null>(null);

  // Create family dialog
  const [familyDialogOpen, setFamilyDialogOpen] = useState(false);

  // Add member dialog
  const [addMemberDialogOpen, setAddMemberDialogOpen] = useState(false);
  const [addMemberFamilyId, setAddMemberFamilyId] = useState<string | null>(null);

  // --- Loaders ---

  const loadUsers = useCallback(() => {
    startTransition(async () => {
      const data = await fetchUsers();
      setUsers(data);
    });
  }, []);

  const loadFamilies = useCallback(() => {
    startTransition(async () => {
      const data = await fetchFamilies();
      setFamilies(data);
    });
  }, []);

  const refresh = useCallback(() => {
    loadUsers();
    loadFamilies();
  }, [loadUsers, loadFamilies]);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- User handlers ---

  function handleCreateUser() {
    setEditingUser(null);
    setUserDialogOpen(true);
  }

  function handleEditUser(user: User) {
    setEditingUser(user);
    setUserDialogOpen(true);
  }

  function handleSaveUser(data: {
    username: string;
    display_name: string;
    pin?: string;
    role: string;
    timezone: string;
  }) {
    startTransition(async () => {
      if (editingUser) {
        const result = await updateUser(editingUser.id, {
          username: data.username,
          display_name: data.display_name,
          role: data.role,
          timezone: data.timezone,
        });
        if (!result.success) {
          setError(result.error ?? "Failed to update user");
          return;
        }
      } else {
        const result = await createUser({
          username: data.username,
          display_name: data.display_name || undefined,
          pin: data.pin!,
          role: data.role,
          timezone: data.timezone || undefined,
        });
        if (!result.success) {
          setError(result.error ?? "Failed to create user");
          return;
        }
      }
      setUserDialogOpen(false);
      setEditingUser(null);
      loadUsers();
    });
  }

  function handleResetPinClick(user: User) {
    setPinUser(user);
    setPinDialogOpen(true);
  }

  function handleResetPin(userId: string, pin: string) {
    startTransition(async () => {
      const result = await resetPin(userId, pin);
      if (!result.success) {
        setError(result.error ?? "Failed to reset PIN");
        return;
      }
      setPinDialogOpen(false);
      setPinUser(null);
    });
  }

  function handleToggleEnabled(user: User) {
    startTransition(async () => {
      const result = user.enabled
        ? await disableUser(user.id)
        : await enableUser(user.id);
      if (!result.success) {
        setError(result.error ?? "Failed to toggle user status");
        return;
      }
      loadUsers();
    });
  }

  // --- Family handlers ---

  function handleCreateFamily(name: string) {
    startTransition(async () => {
      const result = await createFamily(name);
      if (!result.success) {
        setError(result.error ?? "Failed to create family");
        return;
      }
      setFamilyDialogOpen(false);
      loadFamilies();
    });
  }

  function handleAddMemberClick(familyId: string) {
    setAddMemberFamilyId(familyId);
    setAddMemberDialogOpen(true);
  }

  function handleAddMember(familyId: string, userId: string, role: string) {
    startTransition(async () => {
      const result = await addFamilyMember(familyId, userId, role);
      if (!result.success) {
        setError(result.error ?? "Failed to add member");
        return;
      }
      setAddMemberDialogOpen(false);
      setAddMemberFamilyId(null);
      loadFamilies();
    });
  }

  function handleRemoveMember(familyId: string, userId: string) {
    startTransition(async () => {
      const result = await removeFamilyMember(familyId, userId);
      if (!result.success) {
        setError(result.error ?? "Failed to remove member");
        return;
      }
      loadFamilies();
    });
  }

  // Member IDs for the "add member" dialog
  const currentFamily = families.find((f) => f.id === addMemberFamilyId);
  const existingMemberIds = currentFamily?.members.map((m) => m.user_id) ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">User Management</h1>
        <Button
          onClick={refresh}
          disabled={isPending}
          variant="outline"
          size="sm"
        >
          <RefreshCw
            className={`h-4 w-4 mr-1 ${isPending ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      {/* Error */}
      {error && (
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
      )}

      {/* Users Table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-gray-400" />
              <span>Users</span>
              <Badge variant="secondary" className="text-xs">
                {users.length}
              </Badge>
            </div>
            <Button size="sm" onClick={handleCreateUser} disabled={isPending}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              Create User
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {users.length === 0 && !isPending ? (
            <div className="flex flex-col items-center justify-center py-12 text-gray-400">
              <Users className="h-12 w-12 mb-3" />
              <p className="text-sm">No users found.</p>
              <p className="text-xs mt-1">
                Create a user to get started, or check that the gateway admin API is available.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wide pb-2 pr-3">
                      Username
                    </th>
                    <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wide pb-2 pr-3">
                      Display Name
                    </th>
                    <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wide pb-2 pr-3">
                      Role
                    </th>
                    <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wide pb-2 pr-3">
                      Status
                    </th>
                    <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wide pb-2 pr-3">
                      Created
                    </th>
                    <th className="text-right text-xs font-medium text-gray-500 uppercase tracking-wide pb-2">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <UserRow
                      key={user.id}
                      user={user}
                      onEdit={handleEditUser}
                      onResetPin={handleResetPinClick}
                      onToggleEnabled={handleToggleEnabled}
                      isPending={isPending}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Families Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Home className="h-5 w-5 text-gray-400" />
            Families
          </h2>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setFamilyDialogOpen(true)}
            disabled={isPending}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            Create Family
          </Button>
        </div>

        {families.length === 0 && !isPending ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-gray-400">
              <Home className="h-12 w-12 mb-3" />
              <p className="text-sm">No families created yet.</p>
              <p className="text-xs mt-1">
                Create a family to group users together.
              </p>
            </CardContent>
          </Card>
        ) : (
          families.map((family) => (
            <FamilyCard
              key={family.id}
              family={family}
              onAddMember={handleAddMemberClick}
              onRemoveMember={handleRemoveMember}
              isPending={isPending}
            />
          ))
        )}
      </div>

      {/* Dialogs */}
      <UserFormDialog
        open={userDialogOpen}
        onOpenChange={(open) => {
          setUserDialogOpen(open);
          if (!open) setEditingUser(null);
        }}
        editingUser={editingUser}
        onSave={handleSaveUser}
        isPending={isPending}
      />

      <ResetPinDialog
        open={pinDialogOpen}
        onOpenChange={(open) => {
          setPinDialogOpen(open);
          if (!open) setPinUser(null);
        }}
        user={pinUser}
        onReset={handleResetPin}
        isPending={isPending}
      />

      <CreateFamilyDialog
        open={familyDialogOpen}
        onOpenChange={setFamilyDialogOpen}
        onCreate={handleCreateFamily}
        isPending={isPending}
      />

      <AddMemberDialog
        open={addMemberDialogOpen}
        onOpenChange={(open) => {
          setAddMemberDialogOpen(open);
          if (!open) setAddMemberFamilyId(null);
        }}
        familyId={addMemberFamilyId}
        users={users}
        existingMemberIds={existingMemberIds}
        onAdd={handleAddMember}
        isPending={isPending}
      />
    </div>
  );
}
