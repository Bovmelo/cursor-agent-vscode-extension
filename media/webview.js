const vscode = acquireVsCodeApi();
const webviewConfig = window.__cursorAgentWebviewConfig;
if (!webviewConfig) throw new Error("Missing Cursor Agent webview configuration");
const {
  i18n,
  supportsLocalSandbox: SUPPORTS_LOCAL_SANDBOX,
  maxDroppedFileBytes: MAX_DROPPED_FILE_BYTES,
} = webviewConfig;
const messages = document.getElementById("messages");
const home = document.getElementById("home");
const tasks = document.getElementById("tasks");
const taskList = document.getElementById("taskList");
const taskEmpty = document.getElementById("taskEmpty");
const taskSearch = document.getElementById("taskSearch");
const usagePanel = document.getElementById("usagePanel");
const usageTodayTotal = document.getElementById("usageTodayTotal");
const usageWeekTotal = document.getElementById("usageWeekTotal");
const usageMonthTotal = document.getElementById("usageMonthTotal");
const usageChatTotal = document.getElementById("usageChatTotal");
const usageSupervisorTotal = document.getElementById("usageSupervisorTotal");
const usageConversationTotal = document.getElementById("usageConversationTotal");
const usageInlineAcceptance = document.getElementById("usageInlineAcceptance");
const usageBudgetTotal = document.getElementById("usageBudgetTotal");
const usageMonthlyBudgetTotal = document.getElementById("usageMonthlyBudgetTotal");
const usageEstimatedCostTotal = document.getElementById("usageEstimatedCostTotal");
const experimentsPanel = document.getElementById("experimentsPanel");
const experimentList = document.getElementById("experimentList");
const comparePanel = document.getElementById("comparePanel");
const comparePrompt = document.getElementById("comparePrompt");
const compareGrid = document.getElementById("compareGrid");
const compareClose = document.getElementById("compareClose");
const orchestratorPanel = document.getElementById("orchestratorPanel");
const orchestratorList = document.getElementById("orchestratorList");
const orchestratorDetailPanel = document.getElementById("orchestratorDetailPanel");
const orchestratorPrompt = document.getElementById("orchestratorPrompt");
const orchestratorPhaseStrip = document.getElementById("orchestratorPhaseStrip");
const orchestratorError = document.getElementById("orchestratorError");
const orchestratorAgents = document.getElementById("orchestratorAgents");
const orchestratorClose = document.getElementById("orchestratorClose");
const contextPreviewRow = document.getElementById("contextPreviewRow");
const viewAll = document.getElementById("viewAll");
const parallelBar = document.getElementById("parallelBar");
const parallelBarToggle = document.getElementById("parallelBarToggle");
const parallelBarBody = document.getElementById("parallelBarBody");
const parallelBarTitle = document.getElementById("parallelBarTitle");
const parallelBarCount = document.getElementById("parallelBarCount");
const moreButton = document.getElementById("moreButton");
const moreMenu = document.getElementById("moreMenu");
const startParallelAgentButton = document.getElementById("startParallelAgentButton");
const parallelTaskList = document.getElementById("parallelTaskList");
const findInChatButton = document.getElementById("findInChatButton");
const chatFindBar = document.getElementById("chatFindBar");
const chatFindInput = document.getElementById("chatFindInput");
const chatFindCount = document.getElementById("chatFindCount");
const chatFindPrev = document.getElementById("chatFindPrev");
const chatFindNext = document.getElementById("chatFindNext");
const chatFindClose = document.getElementById("chatFindClose");
const historyButton = document.getElementById("historyButton");
const soundButton = document.getElementById("soundButton");
const featureSettingsButton = document.getElementById("featureSettingsButton");
const soundMenu = document.getElementById("soundMenu");
const notificationToggle = document.getElementById("notificationToggle");
const runningSoundToggle = document.getElementById("runningSoundToggle");
const completionSoundToggle = document.getElementById("completionSoundToggle");
const errorSoundToggle = document.getElementById("errorSoundToggle");
const scroller = document.getElementById("scroller");
const prompt = document.getElementById("prompt");
const composerCard = document.querySelector(".composer-wrap .card");
const sendButton = document.getElementById("sendButton");
const attachButton = document.getElementById("attachButton");
const addMenu = document.getElementById("addMenu");
const addMenuContent = document.getElementById("addMenuContent");
const profileChip = document.getElementById("profileChip");
const newChatButton = document.getElementById("newChatButton");
const status = document.getElementById("status");
const messageAnnouncer = document.getElementById("messageAnnouncer");
const runningIndicator = document.getElementById("runningIndicator");
const workspaceLabel = document.getElementById("workspaceLabel");
const auth = document.getElementById("auth");
const authChip = document.getElementById("authChip");
const setupChecklist = document.getElementById("setupChecklist");
const setupChecklistSteps = document.getElementById("setupChecklistSteps");
const setupChecklistDismiss = document.getElementById("setupChecklistDismiss");
const showSetupChecklistButton = document.getElementById("showSetupChecklistButton");
let lastChecklistVisible = false;
let checklistForcedOpen = false;
const sandboxBanner = document.getElementById("sandboxBanner");
const sandboxBannerToggle = document.getElementById("sandboxBannerToggle");
const sandboxBannerText = document.getElementById("sandboxBannerText");
const sandboxBannerLearnMore = document.getElementById("sandboxBannerLearnMore");
const approvalSelect = document.getElementById("approvalSelect");
const modelButton = document.getElementById("modelButton");
const modelButtonLabel = document.getElementById("modelButtonLabel");
const modelPicker = document.getElementById("modelPicker");
const modelSearch = document.getElementById("modelSearch");
const modelList = document.getElementById("modelList");
const modelOptionsPane = document.getElementById("modelOptionsPane");
const modelOptions = document.getElementById("modelOptions");
const contextRow = document.getElementById("contextRow");
const editorChip = document.getElementById("editorChip");
const ctxLabel = document.getElementById("ctxLabel");
const ctxRemove = document.getElementById("ctxRemove");
const memoryChip = document.getElementById("memoryChip");
const memoryChipLabel = document.getElementById("memoryChipLabel");
const mentionRow = document.getElementById("mentionRow");
const queueRow = document.getElementById("queueRow");
const runningActions = document.getElementById("runningActions");
const queueButton = document.getElementById("queueButton");
const interruptButton = document.getElementById("interruptButton");
const filePicker = document.getElementById("filePicker");
const slashPicker = document.getElementById("slashPicker");
let assistantNode;
let assistantRaw = "";
let activeProgress;
let findQuery = "";
let findMatches = [];
let findIndex = -1;
let findBarOpen = false;
let findDebounceTimer;
let running = false;
let activeChatRuns = 0;
let maximumChatRuns = 3;
let parallelTasks = [];
let runningSoundEnabled = false;
let completionSoundEnabled = false;
let errorSoundEnabled = false;
let webviewSoundPlayback = false;
let runningSoundTimer;
let runningAudioContext;
const runningSoundVoices = new Set();
let sandboxUnavailable = false;
let sandboxSupported = true;
let attach = false;
let includeProjectMemory = true;
let projectCommands = [];
let view = "home";
let allConversations = [];
let tasksExpanded = false;
let conversationSearchQuery = "";
let conversationSearchTimer;
let usageSummary = null;
let usageBudget = null;
let usageMonthlyBudget = null;
let usageEstimatedCost = null;
let usageInlineCompletion = null;
let bestOfNExperiments = [];
let orchestratorExperiments = [];
let openOrchestratorId = null;
let contextEstimateTimer;
let selectedFiles = [];
let fileResults = [];
let selectedFileIndex = 0;
let fileRequestId = 0;
let mentionRange;
let slashResults = [];
let selectedSlashIndex = 0;
let slashRange;
let workspacePaths = new Set();
let workspaceBasenames = new Set();
let attachmentRequestId = 0;
let pendingAttachmentResolves = 0;
const attachmentResolveWaiters = [];
let availableModels = [];
let selectedModelId = "auto";
let modelParamState = {};
let runProfile = "agent";
let availableSkills = [];
let selectedSkills = [];
let availableMcpServers = [];
let queuedMessages = [];
let selectedQueueIds = new Set();
let followOutput = true;

let parallelBarExpanded = false;

function setMoreMenuOpen(open) {
  moreMenu.hidden = !open;
  moreButton.classList.toggle("active", open);
  moreButton.setAttribute("aria-expanded", String(open));
  if (!open) {
    setSoundMenuOpen(false);
  }
}

function setSoundMenuOpen(open) {
  soundMenu.hidden = !open;
  soundButton.classList.toggle("active", open);
  soundButton.setAttribute("aria-expanded", String(open));
}

function setParallelBarExpanded(expanded) {
  parallelBarExpanded = expanded;
  parallelBar.classList.toggle("expanded", expanded);
  parallelBarBody.hidden = !expanded;
  parallelBarToggle.setAttribute("aria-expanded", String(expanded));
  parallelBarToggle.title = expanded ? i18n.collapseParallel : i18n.expandParallel;
}

function updateContextRowVisibility() {
  contextRow.hidden = editorChip.hidden;
}

function profileLabel(profile) {
  return {
    agent: i18n.standardProfile,
    plan: i18n.planProfile,
    multitask: i18n.multitaskProfile,
  }[profile] || profile;
}

function updateProfileChip() {
  const labels = [];
  if (runProfile !== "agent") labels.push(profileLabel(runProfile));
  if (selectedSkills.length > 0) labels.push(i18n.skills + " " + selectedSkills.length);
  profileChip.style.display = labels.length > 0 ? "inline-block" : "none";
  profileChip.textContent = labels.join(" · ");
  const accessibleLabel = labels.length > 0 ? labels.join(", ") : i18n.standardProfile;
  profileChip.title = accessibleLabel;
  profileChip.setAttribute("aria-label", accessibleLabel);
  attachButton.classList.toggle("active", attach || labels.length > 0);
}

function addMenuTitle(text) {
  const title = document.createElement("div");
  title.className = "add-menu-title";
  title.setAttribute("role", "presentation");
  title.setAttribute("aria-hidden", "true");
  title.textContent = text;
  addMenuContent.appendChild(title);
}

function addMenuSeparator() {
  const separator = document.createElement("div");
  separator.className = "add-menu-separator";
  separator.setAttribute("role", "separator");
  addMenuContent.appendChild(separator);
}

function addMenuRow(iconText, labelText, options) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "add-menu-row" + (options.selected ? " selected" : "");
  row.disabled = options.disabled === true;
  row.tabIndex = -1;
  row.setAttribute("role", options.role || "menuitem");
  if (options.checked !== undefined) {
    row.setAttribute("aria-checked", String(options.checked));
  }
  if (row.disabled) row.setAttribute("aria-disabled", "true");
  if (options.title) row.title = options.title;
  const icon = document.createElement("span");
  icon.className = "add-menu-icon";
  icon.textContent = iconText;
  const label = document.createElement("span");
  label.className = "add-menu-label";
  label.textContent = labelText;
  row.append(icon, label);
  if (options.meta) {
    const meta = document.createElement("span");
    meta.className = "add-menu-meta";
    meta.textContent = options.meta;
    row.appendChild(meta);
  }
  if (options.onClick) row.addEventListener("click", options.onClick);
  row.addEventListener("focus", () => {
    for (const item of enabledAddMenuItems()) item.tabIndex = item === row ? 0 : -1;
  });
  addMenuContent.appendChild(row);
  return row;
}

function enabledAddMenuItems() {
  return Array.from(addMenuContent.querySelectorAll('[role^="menuitem"]:not(:disabled)'));
}

function focusAddMenuItem(index) {
  const items = enabledAddMenuItems();
  if (items.length === 0) return;
  const targetIndex = Math.max(0, Math.min(index, items.length - 1));
  items.forEach((item, itemIndex) => {
    item.tabIndex = itemIndex === targetIndex ? 0 : -1;
  });
  items[targetIndex].focus({ preventScroll: true });
}

function currentAddMenuFocusIndex() {
  return enabledAddMenuItems().indexOf(document.activeElement);
}

function restoreAddMenuFocus(index) {
  if (!addMenu.hidden && index >= 0) focusAddMenuItem(index);
}

function selectRunProfile(profile) {
  runProfile = profile;
  updateProfileChip();
  closeAddMenu();
  requestContextPreview();
}

function slashCommands() {
  const builtins = [
    {
      id: "agent",
      aliases: ["agent", "standard"],
      label: i18n.standardProfile,
      description: i18n.standardProfileDescription,
      icon: "A",
      profile: "agent",
    },
    {
      id: "plan",
      aliases: ["plan"],
      label: i18n.planProfile,
      description: i18n.planProfileDescription,
      icon: "☷",
      profile: "plan",
    },
    {
      id: "multitask",
      aliases: ["multitask"],
      label: i18n.multitaskProfile,
      description: i18n.multitaskProfileDescription,
      icon: "⑂",
      profile: "multitask",
    },
    {
      id: "compare",
      aliases: ["compare", "bestofn"],
      label: "/compare",
      description: i18n.bestOfNDescription,
      icon: "☰",
      bestOfN: true,
    },
    {
      id: "orchestrate",
      aliases: ["orchestrate"],
      label: "/orchestrate",
      description: i18n.orchestrateDescription,
      icon: "⧉",
      orchestrate: true,
    },
  ];
  const templates = projectCommands.map((command) => ({
    id: command.id,
    aliases: [command.id],
    label: command.label,
    description: command.description
      + (command.source === "user" ? " · " + i18n.userCommand : " · " + i18n.projectCommand),
    icon: "/",
    commandId: command.id,
  }));
  return builtins.concat(templates);
}

function consumeLeadingSlashCommand(text) {
  const compareMatch = /^\/(compare|bestofn)(?:\s+|$)/i.exec(text);
  if (compareMatch) {
    return {
      text: text.slice(compareMatch[0].length).replace(/^\s+/, ""),
      profile: undefined,
      commandId: undefined,
      bestOfN: true,
      orchestrate: false,
    };
  }
  const orchestrateMatch = /^\/(orchestrate)(?:\s+|$)/i.exec(text);
  if (orchestrateMatch) {
    return {
      text: text.slice(orchestrateMatch[0].length).replace(/^\s+/, ""),
      profile: undefined,
      commandId: undefined,
      bestOfN: false,
      orchestrate: true,
    };
  }
  const profileMatch = /^\/(agent|standard|plan|multitask)(?:\s+|$)/i.exec(text);
  if (profileMatch) {
    const command = profileMatch[1].toLowerCase();
    const profile = command === "standard" || command === "agent" ? "agent" : command;
    return {
      text: text.slice(profileMatch[0].length).replace(/^\s+/, ""),
      profile,
      commandId: undefined,
      bestOfN: false,
      orchestrate: false,
    };
  }
  const templateMatch = /^\/([a-z0-9][a-z0-9_-]{0,63})(?:\s+|$)/i.exec(text);
  if (templateMatch) {
    const commandId = templateMatch[1].toLowerCase();
    if (projectCommands.some((command) => command.id === commandId)) {
      return {
        text: text.slice(templateMatch[0].length).replace(/^\s+/, ""),
        profile: undefined,
        commandId,
        bestOfN: false,
        orchestrate: false,
      };
    }
  }
  return { text, profile: undefined, commandId: undefined, bestOfN: false, orchestrate: false };
}

function approvalModeLabel(mode) {
  return {
    "safe-worktree": i18n.safeWorktree,
    "auto-review": i18n.autoReview,
    "full-access": i18n.fullAccess,
  }[mode] || mode;
}

function renderMainAddMenu() {
  const focusIndex = currentAddMenuFocusIndex();
  addMenu.setAttribute("aria-label", i18n.addContextTools);
  addMenuContent.innerHTML = "";
  addMenuTitle(i18n.addContextTools);
  addMenuRow("＋", i18n.attachActive, {
    selected: attach,
    role: "menuitemcheckbox",
    checked: attach,
    onClick: () => {
      setAttach(!attach);
      closeAddMenu();
    },
  });
  addMenuRow("◎", i18n.projectMemory, {
    selected: includeProjectMemory,
    role: "menuitemcheckbox",
    checked: includeProjectMemory,
    meta: includeProjectMemory ? "✓" : "",
    onClick: () => {
      setIncludeProjectMemory(!includeProjectMemory);
      requestContextPreview();
      renderMainAddMenu();
    },
  });
  addMenuSeparator();
  for (const profile of ["agent", "plan", "multitask"]) {
    const icons = { agent: "A", plan: "☷", multitask: "⑂" };
    addMenuRow(icons[profile], profileLabel(profile), {
      selected: runProfile === profile,
      role: "menuitemradio",
      checked: runProfile === profile,
      meta: runProfile === profile ? "✓" : "",
      onClick: () => selectRunProfile(profile),
    });
  }
  addMenuSeparator();
  addMenuTitle(i18n.approvalMode);
  const approvalModes = SUPPORTS_LOCAL_SANDBOX
    ? ["auto-review", "full-access"]
    : ["safe-worktree", "auto-review", "full-access"];
  for (const mode of approvalModes) {
    addMenuRow("⚙", approvalModeLabel(mode), {
      selected: approvalSelect.value === mode,
      role: "menuitemradio",
      checked: approvalSelect.value === mode,
      meta: approvalSelect.value === mode ? "✓" : "",
      onClick: () => {
        setApprovalMode(mode);
        vscode.postMessage({ type: "selectApprovalMode", approvalMode: mode });
        closeAddMenu();
      },
    });
  }
  addMenuSeparator();
  addMenuRow("▧", i18n.image, {
    onClick: () => {
      attachmentRequestId += 1;
      markAttachmentResolveStarted();
      vscode.postMessage({ type: "pickImages", requestId: attachmentRequestId });
      closeAddMenu();
    },
  });
  addMenuRow("◇", i18n.skills, {
    meta: selectedSkills.length > 0 ? String(selectedSkills.length) + " ›" : "›",
    onClick: () => {
      renderSkillsMenu();
      focusAddMenuItem(0);
    },
  });
  addMenuRow("⌁", i18n.mcpServers, {
    meta: availableMcpServers.length > 0 ? String(availableMcpServers.length) + " ›" : "›",
    onClick: () => {
      renderMcpMenu();
      focusAddMenuItem(0);
    },
  });
  restoreAddMenuFocus(focusIndex);
}

function renderSkillsMenu() {
  const focusIndex = currentAddMenuFocusIndex();
  addMenu.setAttribute("aria-label", i18n.skills);
  addMenuContent.innerHTML = "";
  addMenuRow("‹", i18n.back, {
    onClick: () => {
      renderMainAddMenu();
      focusAddMenuItem(0);
    },
  });
  addMenuTitle(i18n.skills);
  if (availableSkills.length === 0) {
    addMenuRow("◇", i18n.noSkills, { disabled: true });
  } else {
    for (const skill of availableSkills) {
      addMenuRow("◇", skill.name, {
        title: skill.description || skill.name,
        selected: selectedSkills.includes(skill.name),
        role: "menuitemcheckbox",
        checked: selectedSkills.includes(skill.name),
        meta: selectedSkills.includes(skill.name) ? "✓" : "",
        onClick: () => {
          if (selectedSkills.includes(skill.name)) {
            selectedSkills = selectedSkills.filter((name) => name !== skill.name);
          } else {
            selectedSkills.push(skill.name);
          }
          updateProfileChip();
          renderSkillsMenu();
        },
      });
    }
  }
  addMenuSeparator();
  addMenuRow("↗", i18n.openSkillsFolder, {
    onClick: () => {
      vscode.postMessage({ type: "openSkillsFolder" });
      closeAddMenu();
    },
  });
  restoreAddMenuFocus(focusIndex);
}

function renderMcpMenu() {
  const focusIndex = currentAddMenuFocusIndex();
  addMenu.setAttribute("aria-label", i18n.mcpServers);
  addMenuContent.innerHTML = "";
  addMenuRow("‹", i18n.back, {
    onClick: () => {
      renderMainAddMenu();
      focusAddMenuItem(0);
    },
  });
  addMenuTitle(i18n.mcpServers);
  if (availableMcpServers.length === 0) {
    addMenuRow("⌁", i18n.noMcpServers, { disabled: true });
  } else {
    for (const server of availableMcpServers) {
      addMenuRow("●", server, { disabled: true, meta: "✓" });
    }
  }
  addMenuSeparator();
  addMenuRow("↗", i18n.openMcpSettings, {
    onClick: () => {
      vscode.postMessage({ type: "openMcpSettings" });
      closeAddMenu();
    },
  });
  restoreAddMenuFocus(focusIndex);
}

let addMenuLauncher = attachButton;

function setAddMenuExpandedState(open) {
  attachButton.setAttribute("aria-expanded", String(open && addMenuLauncher === attachButton));
  profileChip.setAttribute("aria-expanded", String(open && addMenuLauncher === profileChip));
}

function openAddMenu(launcher = attachButton) {
  closeModelPicker();
  addMenuLauncher = launcher;
  renderMainAddMenu();
  addMenu.hidden = false;
  setAddMenuExpandedState(true);
  focusAddMenuItem(0);
}

function focusApprovalModeMenu() {
  setMoreMenuOpen(false);
  openAddMenu(attachButton);
}

function setupChecklistRequiredComplete(steps) {
  if (!steps) return false;
  return steps.apiKey?.complete === true
    && steps.workspaceTrust?.complete === true
    && steps.gitWorkspace?.complete === true
    && steps.permissions?.complete === true;
}

function appendSetupAction(row, label, options) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (options.secondary) button.className = "secondary";
  button.addEventListener("click", options.onClick);
  row.appendChild(button);
}

function renderSetupChecklist(state) {
  const steps = state?.steps || {};
  const becameVisible = state?.visible === true && !lastChecklistVisible;
  lastChecklistVisible = state?.visible === true;
  if (!state?.visible) {
    checklistForcedOpen = false;
  } else if (becameVisible) {
    checklistForcedOpen = true;
  }
  const allRequired = setupChecklistRequiredComplete(steps);
  if (allRequired && !becameVisible) {
    checklistForcedOpen = false;
  }
  const show = state?.visible === true && (!allRequired || checklistForcedOpen);
  setupChecklist.hidden = !show;
  if (!show) {
    setupChecklistSteps.innerHTML = "";
    return;
  }

  const defs = [
    {
      id: "apiKey",
      title: i18n.setupStepApiKey,
      desc: i18n.setupStepApiKeyDesc,
      complete: steps.apiKey?.complete === true,
      renderActions(row) {
        if (steps.apiKey?.complete) return;
        appendSetupAction(row, i18n.setupActionSetApiKey, {
          onClick: () => vscode.postMessage({ type: "setupChecklistAction", id: "apiKey" }),
        });
        appendSetupAction(row, i18n.setupActionOpenDashboard, {
          secondary: true,
          onClick: () => vscode.postMessage({ type: "setupChecklistAction", id: "openDashboard" }),
        });
      },
    },
    {
      id: "workspaceTrust",
      title: i18n.setupStepWorkspaceTrust,
      desc: i18n.setupStepWorkspaceTrustDesc,
      complete: steps.workspaceTrust?.complete === true,
      renderActions(row) {
        if (steps.workspaceTrust?.complete) return;
        appendSetupAction(row, i18n.setupActionTrustWorkspace, {
          onClick: () => vscode.postMessage({ type: "setupChecklistAction", id: "workspaceTrust" }),
        });
      },
    },
    {
      id: "gitWorkspace",
      title: i18n.setupStepGitWorkspace,
      desc: i18n.setupStepGitWorkspaceDesc,
      complete: steps.gitWorkspace?.complete === true,
      renderActions(row) {
        if (steps.gitWorkspace?.complete) return;
        const label = steps.gitWorkspace?.hasWorkspace
          ? i18n.setupActionRefreshGit
          : i18n.setupActionOpenFolder;
        appendSetupAction(row, label, {
          onClick: () => vscode.postMessage({ type: "setupChecklistAction", id: "gitWorkspace" }),
        });
      },
    },
    {
      id: "permissions",
      title: i18n.setupStepPermissions,
      desc: i18n.setupStepPermissionsDesc,
      complete: steps.permissions?.complete === true,
      renderActions(row) {
        if (steps.permissions?.complete) return;
        appendSetupAction(row, i18n.setupActionReviewPermissions, {
          onClick: () => vscode.postMessage({ type: "setupChecklistAction", id: "permissions" }),
        });
        appendSetupAction(row, i18n.setupActionConfirmPermissions, {
          secondary: true,
          onClick: () => vscode.postMessage({ type: "confirmSetupChecklistStep", id: "permissions" }),
        });
      },
    },
    {
      id: "gh",
      title: i18n.setupStepGh,
      desc: i18n.setupStepGhDesc,
      complete: steps.gh?.complete === true,
      optional: true,
      renderActions(row) {
        if (steps.gh?.complete) return;
        appendSetupAction(row, i18n.setupActionCheckGh, {
          onClick: () => vscode.postMessage({ type: "setupChecklistAction", id: "gh" }),
        });
        appendSetupAction(row, i18n.setupActionSkipGh, {
          secondary: true,
          onClick: () => vscode.postMessage({ type: "confirmSetupChecklistStep", id: "gh" }),
        });
        appendSetupAction(row, i18n.setupActionOpenGhSettings, {
          secondary: true,
          onClick: () => vscode.postMessage({ type: "setupChecklistAction", id: "openGhSettings" }),
        });
      },
    },
  ];

  setupChecklistSteps.innerHTML = "";
  for (const def of defs) {
    const step = document.createElement("div");
    step.className = "setup-step" + (def.complete ? " complete" : "");
    const head = document.createElement("div");
    head.className = "setup-step-head";
    const mark = document.createElement("span");
    mark.className = "setup-step-mark";
    mark.textContent = def.complete ? "✓" : "";
    mark.setAttribute("aria-hidden", "true");
    const titleWrap = document.createElement("div");
    const title = document.createElement("span");
    title.className = "setup-step-title";
    title.textContent = def.title;
    titleWrap.appendChild(title);
    if (def.complete) {
      const badge = document.createElement("span");
      badge.className = "setup-step-badge";
      badge.textContent = i18n.setupChecklistComplete;
      titleWrap.appendChild(badge);
    } else if (def.optional) {
      const badge = document.createElement("span");
      badge.className = "setup-step-badge";
      badge.textContent = i18n.setupChecklistOptional;
      titleWrap.appendChild(badge);
    }
    head.appendChild(mark);
    head.appendChild(titleWrap);
    step.appendChild(head);
    const desc = document.createElement("p");
    desc.className = "setup-step-desc";
    desc.textContent = def.desc;
    step.appendChild(desc);
    const actions = document.createElement("div");
    actions.className = "setup-step-actions";
    def.renderActions(actions);
    if (actions.childElementCount > 0) {
      step.appendChild(actions);
    }
    setupChecklistSteps.appendChild(step);
  }
}

function closeAddMenu(options = {}) {
  addMenu.hidden = true;
  setAddMenuExpandedState(false);
  if (options.restoreFocus) {
    const focusTarget = addMenuLauncher === profileChip && profileChip.style.display === "none"
      ? attachButton
      : addMenuLauncher;
    if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
  }
}

function selectedModelDefinition() {
  return availableModels.find((model) => model.id === selectedModelId);
}

function defaultParamsFor(model) {
  const defaultVariant = (model.variants || []).find((variant) => variant.isDefault);
  const params = defaultVariant ? defaultVariant.params.map((param) => ({ ...param })) : [];
  for (const parameter of model.parameters || []) {
    if (!params.some((param) => param.id === parameter.id) && parameter.values.length > 0) {
      params.push({ id: parameter.id, value: parameter.values[0].value });
    }
  }
  return params;
}

function paramsForModel(model) {
  if (!Object.prototype.hasOwnProperty.call(modelParamState, model.id)) {
    modelParamState[model.id] = defaultParamsFor(model);
  }
  return modelParamState[model.id];
}

function updateModelButton() {
  const model = selectedModelDefinition();
  modelButtonLabel.textContent = model ? model.label : selectedModelId;
  modelButton.title = model && model.description
    ? model.label + ": " + model.description
    : modelButtonLabel.textContent;
}

function postModelSelection() {
  const model = selectedModelDefinition();
  vscode.postMessage({
    type: "selectModel",
    modelId: selectedModelId,
    modelParams: model ? paramsForModel(model) : [],
  });
}

function setModelParameter(model, parameterId, value) {
  const params = paramsForModel(model);
  const existing = params.find((param) => param.id === parameterId);
  if (existing) {
    existing.value = value;
  } else {
    params.push({ id: parameterId, value });
  }
  postModelSelection();
  renderModelOptions();
}

function booleanValues(parameter) {
  if (parameter.values.length !== 2) return;
  const truthy = new Set(["true", "on", "enabled", "yes", "1"]);
  const falsy = new Set(["false", "off", "disabled", "no", "0"]);
  const enabled = parameter.values.find((item) =>
    truthy.has(item.value.toLowerCase()) || truthy.has(item.label.toLowerCase()));
  const disabled = parameter.values.find((item) =>
    falsy.has(item.value.toLowerCase()) || falsy.has(item.label.toLowerCase()));
  return enabled && disabled ? { enabled, disabled } : undefined;
}

function hasModelOptions(model) {
  return Boolean(model && ((model.parameters || []).length || (model.variants || []).length));
}

function renderModelList() {
  modelList.innerHTML = "";
  const query = modelSearch.value.trim().toLowerCase();
  const filtered = availableModels.filter((model) =>
    !query || [model.id, model.label, model.description || ""]
      .some((value) => value.toLowerCase().includes(query)));
  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "model-empty";
    empty.textContent = i18n.noMatchingModels;
    modelList.appendChild(empty);
    return;
  }
  for (const model of filtered) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "model-row" + (model.id === selectedModelId ? " selected" : "");
    row.title = model.description || model.label;

    const name = document.createElement("span");
    name.className = "model-row-name";
    name.textContent = model.label;
    row.appendChild(name);
    if (model.description) {
      const description = document.createElement("span");
      description.className = "model-row-description";
      description.textContent = model.description;
      row.appendChild(description);
    }
    row.addEventListener("click", () => {
      selectedModelId = model.id;
      paramsForModel(model);
      updateModelButton();
      postModelSelection();
      renderModelList();
      renderModelOptions();
      if (!hasModelOptions(model)) closeModelPicker();
    });
    modelList.appendChild(row);
  }
}

function addModelOption(group, label, selected, onSelect) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "model-option-row";
  const text = document.createElement("span");
  text.className = "model-option-label";
  text.textContent = label;
  const check = document.createElement("span");
  check.className = "model-check";
  check.textContent = selected ? "✓" : "";
  row.append(text, check);
  row.addEventListener("click", onSelect);
  group.appendChild(row);
}

function renderModelOptions() {
  modelOptions.innerHTML = "";
  const model = selectedModelDefinition();
  const showOptions = hasModelOptions(model);
  modelOptionsPane.hidden = !showOptions;
  modelPicker.classList.toggle("options-empty", !showOptions);
  if (!modelPicker.hidden) requestAnimationFrame(positionModelPicker);
  if (!model || !showOptions) return;

  const params = paramsForModel(model);
  for (const parameter of model.parameters || []) {
    const group = document.createElement("div");
    group.className = "model-param-group";
    const boolean = booleanValues(parameter);
    const selected = params.find((param) => param.id === parameter.id)?.value;
    if (boolean) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "model-toggle-row";
      row.setAttribute("role", "switch");
      const on = selected === boolean.enabled.value;
      row.setAttribute("aria-checked", String(on));
      const label = document.createElement("span");
      label.className = "model-option-label";
      label.textContent = parameter.label;
      const toggle = document.createElement("span");
      toggle.className = "model-switch" + (on ? " on" : "");
      row.append(label, toggle);
      row.addEventListener("click", () =>
        setModelParameter(model, parameter.id, on ? boolean.disabled.value : boolean.enabled.value));
      group.appendChild(row);
    } else {
      const title = document.createElement("div");
      title.className = "model-param-title";
      title.textContent = parameter.label;
      group.appendChild(title);
      for (const value of parameter.values) {
        addModelOption(group, value.label, selected === value.value, () =>
          setModelParameter(model, parameter.id, value.value));
      }
    }
    modelOptions.appendChild(group);
  }

  if ((model.parameters || []).length === 0 && (model.variants || []).length > 0) {
    const group = document.createElement("div");
    group.className = "model-param-group";
    const title = document.createElement("div");
    title.className = "model-param-title";
    title.textContent = i18n.variant;
    group.appendChild(title);
    for (const variant of model.variants) {
      const selected = variant.params.every((expected) =>
        params.some((param) => param.id === expected.id && param.value === expected.value));
      addModelOption(group, variant.label, selected, () => {
        modelParamState[model.id] = variant.params.map((param) => ({ ...param }));
        postModelSelection();
        renderModelOptions();
      });
    }
    modelOptions.appendChild(group);
  }
}

function positionModelPicker() {
  if (modelPicker.hidden) return;
  const narrow = window.innerWidth <= 420;
  const veryNarrow = window.innerWidth <= 300;
  const margin = veryNarrow ? 8 : narrow ? 8 : 12;
  const gap = 6;
  const buttonRect = modelButton.getBoundingClientRect();
  const desiredWidth = modelPicker.classList.contains("options-empty")
    ? narrow ? Math.min(270, window.innerWidth - margin * 2) : 270
    : narrow ? 290 : 500;
  const width = Math.min(desiredWidth, Math.max(0, window.innerWidth - margin * 2));
  const left = Math.min(
    Math.max(margin, buttonRect.right - width),
    Math.max(margin, window.innerWidth - margin - width),
  );
  const availableAbove = Math.max(80, buttonRect.top - gap - margin);
  const maxHeight = Math.min(narrow ? 520 : 430, availableAbove);

  modelPicker.style.left = Math.round(left) + "px";
  modelPicker.style.right = "auto";
  modelPicker.style.bottom = Math.round(window.innerHeight - buttonRect.top + gap) + "px";
  modelPicker.style.width = Math.round(width) + "px";
  modelPicker.style.maxHeight = Math.round(maxHeight) + "px";
}

function openModelPicker() {
  closeAddMenu();
  modelPicker.hidden = false;
  modelButton.setAttribute("aria-expanded", "true");
  renderModelList();
  renderModelOptions();
  positionModelPicker();
  modelSearch.focus();
  modelSearch.select();
}

function closeModelPicker() {
  modelPicker.hidden = true;
  modelButton.setAttribute("aria-expanded", "false");
  modelSearch.value = "";
}

function relTime(ts) {
  const seconds = (Date.now() - ts) / 1000;
  if (seconds < 60) return i18n.justNow;
  const minutes = seconds / 60;
  if (minutes < 60) return Math.floor(minutes) + i18n.minutesAgo;
  const hours = minutes / 60;
  if (hours < 24) return Math.floor(hours) + i18n.hoursAgo;
  const days = hours / 24;
  if (days < 2) return i18n.yesterday;
  if (days < 7) return Math.floor(days) + i18n.daysAgo;
  return new Date(ts).toLocaleDateString();
}

function formatTokens(value) {
  const amount = Number(value) || 0;
  if (amount >= 1000000) {
    return (amount / 1000000).toFixed(amount >= 10000000 ? 0 : 1) + "M";
  }
  if (amount >= 1000) {
    return (amount / 1000).toFixed(amount >= 10000 ? 0 : 1) + "k";
  }
  return String(Math.round(amount));
}

function renderUsagePanel() {
  if (!usageSummary) {
    usagePanel.hidden = true;
    return;
  }
  usagePanel.hidden = false;
  usageTodayTotal.textContent = formatTokens(usageSummary.today.total);
  usageWeekTotal.textContent = formatTokens(usageSummary.last7Days.total);
  usageMonthTotal.textContent = formatTokens(usageSummary.thisMonth?.total || 0);
  usageChatTotal.textContent = formatTokens(usageSummary.last7Days.chat);
  usageSupervisorTotal.textContent = formatTokens(usageSummary.last7Days.supervisor);
  usageConversationTotal.textContent = formatTokens(usageSummary.conversationTotal);
  usageInlineAcceptance.textContent = usageInlineCompletion && usageInlineCompletion.suggested > 0
    ? (Number(usageInlineCompletion.acceptanceRate || 0) * 100).toFixed(1) + "% ("
      + usageInlineCompletion.accepted + "/" + usageInlineCompletion.suggested + ")"
    : "—";
  if (usageBudget && usageBudget.budget > 0) {
    usageBudgetTotal.textContent =
      formatTokens(usageBudget.used) + "/" + formatTokens(usageBudget.budget);
  } else {
    usageBudgetTotal.textContent = "—";
  }
  if (usageMonthlyBudget && usageMonthlyBudget.budget > 0) {
    usageMonthlyBudgetTotal.textContent =
      formatTokens(usageMonthlyBudget.used) + "/" + formatTokens(usageMonthlyBudget.budget);
  } else {
    usageMonthlyBudgetTotal.textContent = "—";
  }
  if (usageEstimatedCost && usageEstimatedCost.limitUsd > 0) {
    usageEstimatedCostTotal.textContent =
      "$" + Number(usageEstimatedCost.estimatedUsd || 0).toFixed(2)
      + "/$" + Number(usageEstimatedCost.limitUsd).toFixed(2);
  } else {
    usageEstimatedCostTotal.textContent = "—";
  }
}

function orchestratorPhaseLabel(status) {
  if (status === "planning") return i18n.orchestratorPhasePlanning;
  if (status === "running") return i18n.orchestratorPhaseRunning;
  if (status === "synthesizing") return i18n.orchestratorPhaseSynthesizing;
  if (status === "failed") return i18n.orchestratorPhaseFailed;
  return i18n.orchestratorPhaseCompleted;
}

function renderExperiments() {
  experimentList.innerHTML = "";
  experimentsPanel.hidden = bestOfNExperiments.length === 0 || !comparePanel.hidden;
  for (const experiment of bestOfNExperiments) {
    const row = document.createElement("div");
    row.className = "task-row";
    const title = document.createElement("span");
    title.className = "task-title";
    title.textContent = experiment.prompt.split("\n")[0] || experiment.id;
    const meta = document.createElement("span");
    meta.className = "task-meta";
    meta.textContent = experiment.candidateCount + " · " + relTime(experiment.createdAt);
    const actions = document.createElement("span");
    actions.className = "task-actions";
    const compare = document.createElement("button");
    compare.className = "task-action";
    compare.type = "button";
    compare.textContent = "⇄";
    compare.title = i18n.compareRuns;
    compare.addEventListener("click", (event) => {
      event.stopPropagation();
      vscode.postMessage({ type: "compareBestOfN", id: experiment.id });
    });
    actions.appendChild(compare);
    row.append(title, meta, actions);
    row.addEventListener("click", () => {
      vscode.postMessage({ type: "compareBestOfN", id: experiment.id });
    });
    experimentList.appendChild(row);
  }
}

function renderCompare(experiment) {
  if (!experiment) {
    comparePanel.hidden = true;
    renderExperiments();
    return;
  }
  renderOrchestratorDetail(null);
  comparePanel.hidden = false;
  experimentsPanel.hidden = true;
  comparePrompt.textContent = experiment.prompt;
  compareGrid.innerHTML = "";
  for (const candidate of experiment.candidates || []) {
    const card = document.createElement("div");
    card.className = "compare-card" + (candidate.isWinner ? " winner" : "");
    const heading = document.createElement("div");
    heading.className = "compare-card-title";
    heading.textContent = (candidate.isWinner ? "★ " : "") + candidate.title
      + (candidate.running ? " · " + i18n.running : "")
      + (candidate.totalTokens ? " · " + formatTokens(candidate.totalTokens) : "");
    const body = document.createElement("div");
    body.className = "compare-card-body";
    body.textContent = candidate.lastAssistant || i18n.noAssistantYet;
    const actions = document.createElement("div");
    actions.className = "compare-card-actions";
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = i18n.openCandidate;
    open.addEventListener("click", () => {
      vscode.postMessage({ type: "openConversation", id: candidate.id });
    });
    actions.appendChild(open);
    if (!candidate.running) {
      const winner = document.createElement("button");
      winner.type = "button";
      winner.textContent = i18n.pickWinner;
      winner.addEventListener("click", () => {
        vscode.postMessage({ type: "pickBestOfNWinner", id: candidate.id });
      });
      actions.appendChild(winner);
    }
    card.append(heading, body, actions);
    compareGrid.appendChild(card);
  }
}

function renderOrchestratorExperiments() {
  orchestratorList.innerHTML = "";
  orchestratorPanel.hidden = orchestratorExperiments.length === 0
    || !orchestratorDetailPanel.hidden;
  for (const experiment of orchestratorExperiments) {
    const row = document.createElement("div");
    row.className = "task-row";
    const title = document.createElement("span");
    title.className = "task-title";
    title.textContent = experiment.prompt.split("\n")[0] || experiment.id;
    const meta = document.createElement("span");
    meta.className = "task-meta";
    const progress = experiment.subtaskCount > 0
      ? experiment.completedCount + "/" + experiment.subtaskCount + " · "
      : "";
    meta.textContent = progress + orchestratorPhaseLabel(experiment.status)
      + (experiment.createdAt ? " · " + relTime(experiment.createdAt) : "");
    row.append(title, meta);
    row.addEventListener("click", () => {
      vscode.postMessage({ type: "openOrchestrator", id: experiment.id });
    });
    orchestratorList.appendChild(row);
  }
}

function fillOrchestratorActivity(el, activity) {
  el.replaceChildren();
  if (!activity || !activity.text) {
    el.hidden = true;
    el.removeAttribute("title");
    return;
  }
  el.hidden = false;
  el.title = activity.text;
  if (activity.path && activity.text.endsWith(activity.path)) {
    const prefix = activity.text.slice(0, -activity.path.length);
    if (prefix) {
      el.appendChild(document.createTextNode(prefix));
    }
    const link = document.createElement("a");
    link.href = "#";
    link.className = "workspace-file-link";
    link.dataset.workspaceFile = activity.path;
    link.textContent = activity.path;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      vscode.postMessage({ type: "openReferencedFile", path: activity.path });
    });
    el.appendChild(link);
  } else {
    el.textContent = activity.text;
  }
}

function fillOrchestratorStatusGlyph(statusEl, status, running) {
  statusEl.replaceChildren();
  if (running || status === "running" || status === "planning" || status === "synthesizing") {
    const spinner = document.createElement("span");
    spinner.className = "running-spinner";
    statusEl.appendChild(spinner);
  } else if (status === "completed") {
    statusEl.textContent = "✓";
  } else if (status === "failed") {
    statusEl.textContent = "!";
  } else if (status === "pending") {
    statusEl.textContent = "…";
  } else {
    statusEl.textContent = "·";
  }
}

function orchestratorStatusMeta(status, running, waiting) {
  if (running) {
    return i18n.running;
  }
  if (status === "completed") {
    return i18n.completedTask;
  }
  if (status === "failed") {
    return i18n.failedTask;
  }
  if (status === "pending") {
    return waiting ? i18n.orchestratorFlowWaiting : i18n.queuedTask;
  }
  return orchestratorPhaseLabel(status);
}

function appendOrchestratorFlowConnector() {
  const connector = document.createElement("div");
  connector.className = "orchestrator-flow-connector";
  connector.setAttribute("aria-hidden", "true");
  connector.textContent = "↓";
  orchestratorAgents.appendChild(connector);
}

function createOpenConversationButton(conversationId, label, title, className) {
  const button = document.createElement("button");
  button.className = className || "task-action";
  button.type = "button";
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    vscode.postMessage({ type: "openConversation", id: conversationId });
  });
  return button;
}

function appendOrchestratorAgentRow(label, status, conversationId, running, activity, options) {
  const waiting = options && options.waiting === true;
  const row = document.createElement("div");
  row.className = "orchestrator-agent-row";
  if (conversationId) {
    row.dataset.conversationId = conversationId;
  }
  const statusEl = document.createElement("span");
  statusEl.className = "orchestrator-agent-status";
  fillOrchestratorStatusGlyph(statusEl, status, running);
  const body = document.createElement("div");
  body.className = "orchestrator-agent-body";
  const title = document.createElement("span");
  title.className = "orchestrator-agent-title";
  title.textContent = label;
  const activityEl = document.createElement("div");
  activityEl.className = "orchestrator-agent-activity";
  fillOrchestratorActivity(activityEl, running ? activity : null);
  body.append(title, activityEl);
  const meta = document.createElement("span");
  meta.className = "orchestrator-agent-meta";
  meta.textContent = orchestratorStatusMeta(status, running, waiting);
  row.append(statusEl, body, meta);
  const actions = document.createElement("span");
  actions.className = "orchestrator-agent-actions";
  if (conversationId) {
    actions.appendChild(createOpenConversationButton(
      conversationId,
      i18n.orchestratorOpenAgent,
      i18n.orchestratorOpenAgent,
      "task-action orchestrator-agent-action",
    ));
  }
  const finalResultConversationId = options?.finalResultConversationId;
  if (finalResultConversationId && finalResultConversationId !== conversationId) {
    actions.appendChild(createOpenConversationButton(
      finalResultConversationId,
      i18n.orchestratorFinalResult,
      i18n.orchestratorOpenFinalResult,
      "task-action orchestrator-result-action",
    ));
  }
  if (actions.childElementCount > 0) {
    row.appendChild(actions);
  }
  orchestratorAgents.appendChild(row);
}

function createOrchestratorFlowSubtask(subtask, finalResultConversationId) {
  const node = document.createElement("div");
  node.className = "orchestrator-flow-subtask";
  if (subtask.conversationId) {
    node.dataset.conversationId = subtask.conversationId;
  }
  if (subtask.id) {
    node.dataset.subtaskId = subtask.id;
  }
  const top = document.createElement("div");
  top.className = "orchestrator-flow-subtask-top";
  const statusEl = document.createElement("span");
  statusEl.className = "orchestrator-agent-status";
  fillOrchestratorStatusGlyph(statusEl, subtask.status, subtask.running === true);
  const body = document.createElement("div");
  body.className = "orchestrator-flow-subtask-body";
  const title = document.createElement("span");
  title.className = "orchestrator-agent-title";
  title.textContent = subtask.title;
  const activityEl = document.createElement("div");
  activityEl.className = "orchestrator-agent-activity";
  fillOrchestratorActivity(activityEl, subtask.running === true ? subtask.activity : null);
  body.append(title, activityEl);
  if (subtask.status === "completed") {
    const summaryText = typeof subtask.resultSummary === "string"
      ? subtask.resultSummary.trim().replace(/\s+/g, " ")
      : "";
    if (summaryText) {
      const summaryEl = document.createElement("div");
      summaryEl.className = "orchestrator-flow-subtask-summary";
      summaryEl.textContent = summaryText;
      summaryEl.title = summaryText;
      body.appendChild(summaryEl);
    }
  }
  top.append(statusEl, body);
  node.appendChild(top);
  const actions = document.createElement("span");
  actions.className = "orchestrator-agent-actions";
  if (subtask.conversationId) {
    actions.appendChild(createOpenConversationButton(
      subtask.conversationId,
      i18n.orchestratorOpenAgent,
      i18n.orchestratorOpenAgent,
      "task-action orchestrator-agent-action",
    ));
  }
  if (finalResultConversationId && finalResultConversationId !== subtask.conversationId) {
    actions.appendChild(createOpenConversationButton(
      finalResultConversationId,
      i18n.orchestratorFinalResult,
      i18n.orchestratorOpenFinalResult,
      "task-action orchestrator-result-action",
    ));
  }
  if (actions.childElementCount > 0) {
    node.appendChild(actions);
  }
  return node;
}

function patchOrchestratorActivity(message) {
  if (!message || !openOrchestratorId || message.experimentId !== openOrchestratorId) {
    return;
  }
  const rows = orchestratorAgents.querySelectorAll(
    ".orchestrator-agent-row, .orchestrator-flow-subtask",
  );
  for (const row of rows) {
    if (message.conversationId && row.dataset.conversationId === message.conversationId) {
      const activityEl = row.querySelector(".orchestrator-agent-activity");
      if (activityEl) {
        fillOrchestratorActivity(activityEl, message.activity);
      }
      return;
    }
    if (message.subtaskId && row.dataset.subtaskId === message.subtaskId) {
      const activityEl = row.querySelector(".orchestrator-agent-activity");
      if (activityEl) {
        fillOrchestratorActivity(activityEl, message.activity);
      }
      return;
    }
  }
}

function patchParallelTaskActivity(message) {
  if (!message || !message.conversationId) {
    return;
  }
  const chip = parallelTaskList.querySelector(
    '.parallel-task[data-conversation-id="' + message.conversationId + '"]',
  );
  if (!chip) {
    return;
  }
  let activityEl = chip.querySelector(".parallel-task-activity");
  const text = message.activity && message.activity.text ? message.activity.text : "";
  if (!text) {
    if (activityEl) {
      activityEl.remove();
    }
    chip.classList.remove("has-activity");
    return;
  }
  if (!activityEl) {
    const copy = chip.querySelector(".parallel-task-copy");
    activityEl = document.createElement("span");
    activityEl.className = "parallel-task-activity";
    if (copy) {
      copy.appendChild(activityEl);
    }
  }
  activityEl.textContent = text;
  activityEl.title = text;
  chip.classList.add("has-activity");
}

function renderOrchestratorDetail(experiment) {
  if (!experiment) {
    openOrchestratorId = null;
    orchestratorDetailPanel.hidden = true;
    renderOrchestratorExperiments();
    return;
  }
  if (!comparePanel.hidden) {
    comparePanel.hidden = true;
    renderExperiments();
  }
  openOrchestratorId = experiment.id;
  orchestratorDetailPanel.hidden = false;
  orchestratorPanel.hidden = true;
  orchestratorPrompt.textContent = experiment.prompt;
  if (experiment.error) {
    orchestratorError.hidden = false;
    orchestratorError.textContent = experiment.error;
  } else {
    orchestratorError.hidden = true;
    orchestratorError.textContent = "";
  }
  const phases = [
    { id: "planning", label: i18n.orchestratorPhasePlanning },
    { id: "running", label: i18n.orchestratorPhaseRunning },
    { id: "synthesizing", label: i18n.orchestratorPhaseSynthesizing },
    { id: "completed", label: i18n.orchestratorPhaseCompleted },
  ];
  const order = { planning: 0, running: 1, synthesizing: 2, completed: 3, failed: 3 };
  const current = order[experiment.status] ?? 0;
  orchestratorPhaseStrip.innerHTML = "";
  for (const phase of phases) {
    const chip = document.createElement("span");
    const phaseOrder = order[phase.id] ?? 0;
    chip.className = "orchestrator-phase"
      + (experiment.status === "failed" && phase.id === "completed"
        ? " active"
        : phase.id === experiment.status
          ? " active"
          : phaseOrder < current
            ? " done"
            : "");
    chip.textContent = experiment.status === "failed" && phase.id === "completed"
      ? i18n.orchestratorPhaseFailed
      : phase.label;
    orchestratorPhaseStrip.appendChild(chip);
  }
  orchestratorAgents.innerHTML = "";
  orchestratorAgents.className = "orchestrator-flow";
  const finalResultConversationId = experiment.status === "completed"
    ? experiment.synthesis?.conversationId
    : undefined;
  const planStatus = experiment.status === "planning"
    ? "planning"
    : experiment.plan?.running
      ? "running"
      : "completed";
  appendOrchestratorAgentRow(
    i18n.orchestratorPlanAgent,
    planStatus,
    experiment.plan?.conversationId,
    experiment.plan?.running === true,
    experiment.plan?.activity,
    { finalResultConversationId },
  );
  appendOrchestratorFlowConnector();
  const subtasksBand = document.createElement("div");
  subtasksBand.className = "orchestrator-flow-subtasks";
  const subtasksHeader = document.createElement("div");
  subtasksHeader.className = "orchestrator-flow-subtasks-header";
  const subtasks = experiment.subtasks || [];
  subtasksHeader.textContent = i18n.orchestratorFlowSubtasks
    + (subtasks.length > 0 ? " · " + subtasks.length : "");
  const subtasksRow = document.createElement("div");
  subtasksRow.className = "orchestrator-flow-subtasks-row";
  for (const subtask of subtasks) {
    subtasksRow.appendChild(createOrchestratorFlowSubtask(subtask, finalResultConversationId));
  }
  subtasksBand.append(subtasksHeader, subtasksRow);
  orchestratorAgents.appendChild(subtasksBand);
  appendOrchestratorFlowConnector();
  const synthesisStatus = experiment.status === "synthesizing"
    ? "synthesizing"
    : experiment.status === "completed"
      ? "completed"
      : experiment.status === "failed" && experiment.synthesis?.conversationId
        ? "failed"
        : "pending";
  appendOrchestratorAgentRow(
    i18n.orchestratorSynthesisAgent,
    synthesisStatus,
    experiment.synthesis?.conversationId,
    experiment.synthesis?.running === true,
    experiment.synthesis?.activity,
    { waiting: synthesisStatus === "pending" },
  );
}

function requestContextPreview() {
  clearTimeout(contextEstimateTimer);
  contextEstimateTimer = setTimeout(() => {
    const consumed = consumeLeadingSlashCommand(prompt.value.trim());
    vscode.postMessage({
      type: "estimateContext",
      prompt: consumed.text || prompt.value,
      profile: consumed.profile || runProfile,
      includeProjectMemory,
      attachContext: attach,
      path: ctxLabel.textContent || undefined,
      files: selectedFiles.map((file) => file.path),
      skills: selectedSkills.slice(),
      commandId: consumed.commandId,
    });
  }, 160);
}

function renderContextPreview(chips) {
  contextPreviewRow.innerHTML = "";
  if (!chips || chips.length === 0) {
    contextPreviewRow.hidden = true;
    return;
  }
  contextPreviewRow.hidden = false;
  for (const chip of chips) {
    const node = document.createElement("span");
    node.className = "preview-chip";
    node.textContent = chip.label;
    contextPreviewRow.appendChild(node);
  }
}

function renderTasks() {
  taskList.innerHTML = "";
  const searching = conversationSearchQuery.trim().length > 0;
  tasks.hidden = allConversations.length === 0 && !searching;
  taskEmpty.hidden = allConversations.length > 0 || !searching;
  const items = tasksExpanded ? allConversations : allConversations.slice(0, 5);
  for (const conv of items) {
    const row = document.createElement("div");
    row.className = "task-row"
      + (conv.running ? " running" : "")
      + (conv.pinned ? " pinned" : "");
    row.title = conv.title;

    const title = document.createElement("span");
    title.className = "task-title";
    title.textContent = conv.title;

    const meta = document.createElement("span");
    meta.className = "task-meta";
    const tokens = document.createElement("span");
    tokens.className = "task-tokens";
    if (conv.totalTokens > 0) {
      tokens.textContent = formatTokens(conv.totalTokens);
      tokens.title = formatTokens(conv.totalTokens) + " " + i18n.tokensLabel;
    }
    const time = document.createElement("span");
    time.className = "task-time";
    time.textContent = conv.running
      ? "● " + i18n.running
      : conv.queued
        ? "◷ " + i18n.queuedTask
        : relTime(conv.updatedAt);
    meta.append(tokens, time);

    const actions = document.createElement("span");
    actions.className = "task-actions";

    const pin = document.createElement("button");
    pin.className = "task-action";
    pin.type = "button";
    pin.textContent = conv.pinned ? "★" : "☆";
    pin.title = conv.pinned ? i18n.unpinConversation : i18n.pinConversation;
    pin.addEventListener("click", (event) => {
      event.stopPropagation();
      vscode.postMessage({ type: "pinConversation", id: conv.id, pinned: !conv.pinned });
    });

    const exp = document.createElement("button");
    exp.className = "task-action";
    exp.type = "button";
    exp.textContent = "⇪";
    exp.title = i18n.exportConversation;
    exp.addEventListener("click", (event) => {
      event.stopPropagation();
      vscode.postMessage({ type: "exportConversation", id: conv.id, format: "markdown" });
    });

    const del = document.createElement("button");
    del.className = "task-action task-delete";
    del.type = "button";
    del.textContent = "×";
    del.title = i18n.deleteConversation;
    del.addEventListener("click", (event) => {
      event.stopPropagation();
      vscode.postMessage({ type: "deleteConversation", id: conv.id });
    });

    if (conv.experimentGroupId && !conv.running) {
      const winner = document.createElement("button");
      winner.className = "task-action";
      winner.type = "button";
      winner.textContent = "✓";
      winner.title = i18n.pickWinner;
      winner.addEventListener("click", (event) => {
        event.stopPropagation();
        vscode.postMessage({ type: "pickBestOfNWinner", id: conv.id });
      });
      actions.appendChild(winner);
    }
    const finalResult = conv.orchestratorFinalResultConversationId
      ? createOpenConversationButton(
          conv.orchestratorFinalResultConversationId,
          i18n.orchestratorFinalResult,
          i18n.orchestratorOpenFinalResult,
          "task-final-result",
        )
      : null;
    actions.append(pin, exp, del);
    row.append(title);
    if (finalResult) {
      row.appendChild(finalResult);
    }
    row.append(meta, actions);
    row.addEventListener("click", () => vscode.postMessage({ type: "openConversation", id: conv.id }));
    taskList.appendChild(row);
  }
  viewAll.hidden = tasksExpanded || allConversations.length <= 5;
  viewAll.textContent = i18n.showAll + " (" + allConversations.length + ")";
}

function createParallelTaskChip(task) {
  const chip = document.createElement("div");
  const activityText = task.status === "running" && task.activity && task.activity.text
    ? task.activity.text
    : "";
  chip.className = "parallel-task " + task.status + (task.active ? " active" : "")
    + (activityText ? " has-activity" : "");
  chip.dataset.conversationId = task.id;

  const main = document.createElement("button");
  main.className = "parallel-task-main";
  main.type = "button";
  main.title = activityText
    ? i18n.switchTask + ": " + task.title + " · " + activityText
    : i18n.switchTask + ": " + task.title;
  main.setAttribute("aria-label", main.title);

  const taskStatus = document.createElement("span");
  taskStatus.className = "parallel-task-status";
  const taskStatusLabel = task.status === "running"
    ? i18n.running
    : task.status === "queued"
      ? i18n.queuedTask
      : task.status === "error"
        ? i18n.failedTask
        : task.status === "stopped"
          ? i18n.stoppedTask
          : i18n.completedTask;
  taskStatus.title = taskStatusLabel;
  if (task.status === "running") {
    const spinner = document.createElement("span");
    spinner.className = "running-spinner";
    taskStatus.appendChild(spinner);
  } else if (task.status === "queued") {
    taskStatus.textContent = "◷";
  } else if (task.status === "error") {
    taskStatus.textContent = "!";
  } else if (task.status === "stopped") {
    taskStatus.textContent = "■";
  } else {
    taskStatus.textContent = "✓";
  }

  const copy = document.createElement("span");
  copy.className = "parallel-task-copy";
  const title = document.createElement("span");
  title.className = "parallel-task-title";
  title.textContent = task.title;
  copy.appendChild(title);
  if (activityText) {
    const activityEl = document.createElement("span");
    activityEl.className = "parallel-task-activity";
    activityEl.textContent = activityText;
    activityEl.title = activityText;
    copy.appendChild(activityEl);
  }

  main.append(taskStatus, copy);
  if (Number(task.queueCount) > 0) {
    const queued = document.createElement("span");
    queued.className = "parallel-task-queue-count";
    queued.textContent = "+" + task.queueCount;
    queued.title = task.queueCount + " " + i18n.queuedTask;
    main.appendChild(queued);
  }
  main.addEventListener("click", () => {
    vscode.postMessage({ type: "openConversation", id: task.id });
  });

  chip.appendChild(main);
  if (task.orchestratorFinalResultConversationId) {
    chip.appendChild(createOpenConversationButton(
      task.orchestratorFinalResultConversationId,
      "↗",
      i18n.orchestratorOpenFinalResult,
      "parallel-task-result",
    ));
  }
  if (task.status === "running" || task.status === "queued") {
    const stop = document.createElement("button");
    stop.className = "parallel-task-stop";
    stop.type = "button";
    stop.textContent = "×";
    stop.title = task.status === "running" ? i18n.stopTask : i18n.removeQueuedTask;
    stop.setAttribute("aria-label", stop.title + ": " + task.title);
    stop.addEventListener("click", (event) => {
      event.stopPropagation();
      vscode.postMessage({ type: "cancelConversation", id: task.id });
    });
    chip.appendChild(stop);
  }
  return chip;
}

function renderParallelBar() {
  parallelBar.hidden = parallelTasks.length === 0;
  parallelBarTitle.textContent = i18n.parallelAgents;
  parallelBarCount.textContent = activeChatRuns + "/" + maximumChatRuns;
  startParallelAgentButton.hidden = activeChatRuns === 0;
  startParallelAgentButton.disabled = activeChatRuns >= maximumChatRuns;
  startParallelAgentButton.title = startParallelAgentButton.disabled
    ? i18n.parallelLimitReached + " (" + activeChatRuns + "/" + maximumChatRuns + ")"
    : i18n.launchParallelAgent;
  parallelTaskList.innerHTML = "";

  const groups = new Map();
  const ungrouped = [];
  for (const task of parallelTasks) {
    if (task.orchestratorExperimentId) {
      const list = groups.get(task.orchestratorExperimentId) || [];
      list.push(task);
      groups.set(task.orchestratorExperimentId, list);
    } else {
      ungrouped.push(task);
    }
  }
  for (const [experimentId, tasks] of groups) {
    const group = document.createElement("div");
    group.className = "parallel-group";
    const header = document.createElement("button");
    header.className = "parallel-group-header";
    header.type = "button";
    header.title = i18n.orchestratorDetailTitle;
    const runningCount = tasks.filter((task) => task.status === "running").length;
    header.textContent = i18n.orchestratorGroup + " · " + runningCount + "/" + tasks.length;
    header.addEventListener("click", () => {
      vscode.postMessage({ type: "openOrchestrator", id: experimentId });
    });
    const chips = document.createElement("div");
    chips.className = "parallel-group-tasks";
    const ordered = [...tasks].sort((a, b) => {
      const roleOrder = (role) => (
        role === "plan" ? 0 : role === "subtask" ? 1 : role === "synthesis" ? 2 : 3
      );
      const byRole = roleOrder(a.orchestratorRole) - roleOrder(b.orchestratorRole);
      if (byRole !== 0) {
        return byRole;
      }
      if (a.orchestratorRole === "subtask" && b.orchestratorRole === "subtask") {
        const aIndex = Number.isFinite(a.orchestratorSubtaskIndex)
          ? a.orchestratorSubtaskIndex
          : Number.MAX_SAFE_INTEGER;
        const bIndex = Number.isFinite(b.orchestratorSubtaskIndex)
          ? b.orchestratorSubtaskIndex
          : Number.MAX_SAFE_INTEGER;
        return aIndex - bIndex;
      }
      return 0;
    });
    for (const task of ordered) {
      chips.appendChild(createParallelTaskChip(task));
    }
    group.append(header, chips);
    parallelTaskList.appendChild(group);
  }
  for (const task of ungrouped) {
    parallelTaskList.appendChild(createParallelTaskChip(task));
  }
}

function clearFindHighlights() {
  for (const mark of messages.querySelectorAll("mark.chat-find-hit")) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }
  findMatches = [];
  findIndex = -1;
}

function selectFindMatch(index) {
  if (findIndex >= 0 && findMatches[findIndex]) {
    findMatches[findIndex].classList.remove("chat-find-current");
  }
  findIndex = index;
  const mark = findMatches[findIndex];
  if (!mark) return;
  mark.classList.add("chat-find-current");
  mark.scrollIntoView({ block: "center", behavior: "smooth" });
  chatFindCount.textContent = String(i18n.findMatchCount || "{current} / {total}")
    .replace("{current}", String(findIndex + 1))
    .replace("{total}", String(findMatches.length));
}

function applyFindHighlights(query, preferredIndex) {
  const previousIndex = typeof preferredIndex === "number" ? preferredIndex : findIndex;
  clearFindHighlights();
  findQuery = typeof query === "string" ? query : "";
  if (!findQuery) {
    chatFindCount.textContent = "";
    return;
  }
  const needle = findQuery.toLowerCase();
  const bodies = messages.querySelectorAll(":scope > .message > .message-body");
  for (const body of bodies) {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    for (const textNode of textNodes) {
      const text = textNode.nodeValue || "";
      if (!text) continue;
      const lower = text.toLowerCase();
      let start = 0;
      let matchAt = lower.indexOf(needle, start);
      if (matchAt < 0) continue;
      const frag = document.createDocumentFragment();
      while (matchAt >= 0) {
        if (matchAt > start) {
          frag.appendChild(document.createTextNode(text.slice(start, matchAt)));
        }
        const mark = document.createElement("mark");
        mark.className = "chat-find-hit";
        mark.textContent = text.slice(matchAt, matchAt + needle.length);
        frag.appendChild(mark);
        findMatches.push(mark);
        start = matchAt + needle.length;
        matchAt = lower.indexOf(needle, start);
      }
      if (start < text.length) {
        frag.appendChild(document.createTextNode(text.slice(start)));
      }
      textNode.parentNode?.replaceChild(frag, textNode);
    }
  }
  if (findMatches.length === 0) {
    chatFindCount.textContent = i18n.findNoMatches;
    findIndex = -1;
    return;
  }
  const index = Math.max(0, Math.min(previousIndex >= 0 ? previousIndex : 0, findMatches.length - 1));
  selectFindMatch(index);
}

function gotoFindMatch(delta) {
  if (findMatches.length === 0) return;
  const next = (findIndex + delta + findMatches.length) % findMatches.length;
  selectFindMatch(next);
}

function openFindBar() {
  if (view !== "chat") return;
  findBarOpen = true;
  chatFindBar.hidden = false;
  findInChatButton.classList.add("active");
  chatFindInput.focus();
  chatFindInput.select();
  if (chatFindInput.value) {
    applyFindHighlights(chatFindInput.value);
  }
}

function closeFindBar() {
  findBarOpen = false;
  chatFindBar.hidden = true;
  findInChatButton.classList.remove("active");
  clearFindHighlights();
  findQuery = "";
  chatFindCount.textContent = "";
  clearTimeout(findDebounceTimer);
}

function reapplyFindIfActive() {
  if (findBarOpen && findQuery) {
    applyFindHighlights(findQuery, findIndex);
  }
}

function scheduleFind() {
  clearTimeout(findDebounceTimer);
  findDebounceTimer = setTimeout(() => {
    applyFindHighlights(chatFindInput.value);
  }, 150);
}

function updateFindChrome() {
  findInChatButton.hidden = view !== "chat";
  if (view !== "chat") {
    closeFindBar();
  }
}

function clearMessages() {
  messages.innerHTML = "";
  assistantNode = undefined;
  assistantRaw = "";
  activeProgress = undefined;
  followOutput = true;
  scroller.scrollTop = 0;
  findMatches = [];
  findIndex = -1;
  if (!findBarOpen) {
    findQuery = "";
  }
}

function showHome(convs, query) {
  view = "home";
  setRunningState(false);
  if (convs) {
    allConversations = convs;
    tasksExpanded = false;
  }
  if (typeof query === "string" && taskSearch.value !== query) {
    conversationSearchQuery = query;
    taskSearch.value = query;
  }
  clearMessages();
  home.style.display = "flex";
  messages.style.display = "none";
  updateFindChrome();
  renderUsagePanel();
  renderExperiments();
  renderOrchestratorExperiments();
  renderTasks();
}

function showChat() {
  view = "chat";
  home.style.display = "none";
  messages.style.display = "flex";
  updateFindChrome();
}

function setRunningState(value) {
  running = value;
  if (value) {
    status.setAttribute("aria-busy", "true");
    startRunningSound();
    runningIndicator.hidden = false;
    sendButton.classList.add("running");
    sendButton.title = i18n.stop;
    runningActions.hidden = false;
    status.textContent = i18n.running + "…"
      + (activeChatRuns > 1 ? " · " + activeChatRuns + " " + i18n.activeAgents : "");
  } else {
    stopRunningSound();
    runningIndicator.hidden = true;
    sendButton.classList.remove("running");
    sendButton.title = i18n.send;
    runningActions.hidden = true;
    status.textContent = sandboxUnavailable
      ? sandboxStatusForMode(approvalSelect.value)
      : i18n.connected;
    status.setAttribute("aria-busy", "false");
  }
}

let announcementTimer;
let lastAnnouncement = "";
function announcePolite(message) {
  if (!message || message === lastAnnouncement) return;
  clearTimeout(announcementTimer);
  announcementTimer = setTimeout(() => {
    messageAnnouncer.textContent = message;
    lastAnnouncement = message;
  }, 300);
}

function setAttach(value) {
  attach = value;
  updateProfileChip();
  editorChip.hidden = !attach;
  updateContextRowVisibility();
  if (attach) vscode.postMessage({ type: "getContext" });
  requestContextPreview();
}

function setIncludeProjectMemory(value) {
  includeProjectMemory = value;
  memoryChip.setAttribute("aria-pressed", String(value));
  memoryChip.title = value ? i18n.projectMemoryOn : i18n.projectMemoryOff;
  memoryChipLabel.textContent = i18n.projectMemory;
}

let executionProfileLabel = "";

function refreshApprovalSelectTitle() {
  const mode = approvalSelect.value;
  const descriptions = {
    "safe-worktree": i18n.safeWorktreeDescription,
    "auto-review": i18n.autoReviewDescription,
    "full-access": i18n.fullAccessDescription,
  };
  const base = descriptions[mode] || i18n.approvalMode;
  approvalSelect.title = executionProfileLabel ? `${base} · ${executionProfileLabel}` : base;
}

function setApprovalMode(mode) {
  approvalSelect.value = mode;
  // On platforms without a local sandbox, isolation is never available
  // regardless of the selected mode, so keep the warning state sticky.
  sandboxUnavailable = !sandboxSupported;
  refreshApprovalSelectTitle();
  updateSandboxBanner();
  if (!running && !sandboxSupported) {
    status.textContent = sandboxStatusForMode(mode);
  }
}

function sandboxStatusForMode(mode) {
  if (mode === "safe-worktree") return i18n.safeModeStatus;
  if (mode === "full-access") return i18n.fullAccessStatus;
  return i18n.sandboxUnavailable;
}

let sandboxBannerExpanded = false;

function setSandboxBannerExpanded(expanded) {
  sandboxBannerExpanded = expanded;
  if (sandboxBannerToggle) {
    sandboxBannerToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    const warning = sandboxBannerText?.textContent || i18n.sandboxBannerDirectText;
    sandboxBannerToggle.title = expanded
      ? i18n.collapseSandboxBanner
      : (warning || i18n.expandSandboxBanner);
    sandboxBannerToggle.setAttribute(
      "aria-label",
      expanded ? i18n.collapseSandboxBanner : i18n.sandboxBannerLabel,
    );
  }
  if (sandboxBanner) {
    sandboxBanner.hidden = !expanded || !sandboxBannerToggle || sandboxBannerToggle.hidden;
  }
}

function updateSandboxBanner() {
  const safeWorktreeActive = approvalSelect.value === "safe-worktree";
  const visible = !sandboxSupported && !safeWorktreeActive;
  if (sandboxBannerToggle) {
    sandboxBannerToggle.hidden = !visible;
  }
  if (sandboxBannerText) {
    sandboxBannerText.textContent = i18n.sandboxBannerDirectText;
  }
  if (!visible) {
    if (sandboxBanner) sandboxBanner.hidden = true;
    return;
  }
  setSandboxBannerExpanded(sandboxBannerExpanded);
}

function updateContextChip(label) {
  if (label) {
    ctxLabel.textContent = label;
    ctxLabel.classList.remove("none");
  } else {
    ctxLabel.textContent = i18n.noActiveFile;
    ctxLabel.classList.add("none");
  }
}

function activeMention() {
  const caret = prompt.selectionStart;
  const beforeCaret = prompt.value.slice(0, caret);
  const match = /(^|\s)@([^\s@]*)$/.exec(beforeCaret);
  if (!match) return undefined;
  return {
    start: caret - match[2].length - 1,
    end: caret,
    query: match[2],
  };
}

function activeSlashCommand() {
  const caret = prompt.selectionStart;
  const beforeCaret = prompt.value.slice(0, caret);
  const match = /(^|\s)\/([\w-]*)$/.exec(beforeCaret);
  if (!match) return undefined;
  return {
    start: caret - match[2].length - 1,
    end: caret,
    query: match[2].toLowerCase(),
  };
}

function syncPromptSuggestionAria() {
  const activePicker = !filePicker.hidden
    ? filePicker
    : (!slashPicker.hidden ? slashPicker : undefined);
  prompt.setAttribute("aria-expanded", String(Boolean(activePicker)));
  if (activePicker) {
    prompt.setAttribute("aria-controls", activePicker.id);
  } else {
    prompt.removeAttribute("aria-controls");
  }
  const activeOption = activePicker?.querySelector('[role="option"][aria-selected="true"]');
  if (activeOption?.id) {
    prompt.setAttribute("aria-activedescendant", activeOption.id);
  } else {
    prompt.removeAttribute("aria-activedescendant");
  }
}

function closeFilePicker() {
  filePicker.hidden = true;
  filePicker.innerHTML = "";
  fileResults = [];
  selectedFileIndex = 0;
  mentionRange = undefined;
  syncPromptSuggestionAria();
}

function closeSlashPicker() {
  slashPicker.hidden = true;
  slashPicker.innerHTML = "";
  slashResults = [];
  selectedSlashIndex = 0;
  slashRange = undefined;
  syncPromptSuggestionAria();
}

function requestFileResults() {
  const mention = activeMention();
  if (!mention) {
    closeFilePicker();
    return;
  }
  closeSlashPicker();
  mentionRange = mention;
  selectedFileIndex = 0;
  fileRequestId += 1;
  vscode.postMessage({
    type: "searchFiles",
    query: mention.query,
    requestId: fileRequestId,
  });
}

function requestSlashResults() {
  if (activeMention()) {
    closeSlashPicker();
    return;
  }
  const slash = activeSlashCommand();
  if (!slash) {
    closeSlashPicker();
    return;
  }
  closeFilePicker();
  slashRange = slash;
  slashResults = slashCommands().filter((command) =>
    command.aliases.some((alias) => alias.startsWith(slash.query))
      || command.label.toLowerCase().startsWith(slash.query),
  );
  selectedSlashIndex = 0;
  renderSlashResults();
}

function renderSlashResults() {
  slashPicker.innerHTML = "";
  if (slashResults.length === 0) {
    const empty = document.createElement("div");
    empty.className = "file-empty";
    empty.textContent = i18n.noMatchingCommands;
    slashPicker.appendChild(empty);
    slashPicker.hidden = false;
    syncPromptSuggestionAria();
    return;
  }

  selectedSlashIndex = Math.max(0, Math.min(selectedSlashIndex, slashResults.length - 1));
  slashResults.forEach((command, index) => {
    const row = document.createElement("button");
    row.className = "file-result" + (index === selectedSlashIndex ? " selected" : "");
    row.type = "button";
    row.tabIndex = -1;
    row.id = "slash-picker-option-" + index;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", index === selectedSlashIndex ? "true" : "false");
    row.title = "/" + command.id;

    const icon = document.createElement("span");
    icon.textContent = command.icon;
    const label = document.createElement("span");
    label.className = "file-result-label";
    label.textContent = "/" + command.id;
    const description = document.createElement("span");
    description.className = "file-result-path";
    description.textContent = command.description;
    row.append(icon, label, description);
    row.addEventListener("mousedown", (event) => event.preventDefault());
    row.addEventListener("click", () => selectSlashCommand(command));
    slashPicker.appendChild(row);
  });
  slashPicker.hidden = false;
  syncPromptSuggestionAria();
  slashPicker.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}

function selectSlashCommand(command) {
  if (command.bestOfN) {
    const before = slashRange ? prompt.value.slice(0, slashRange.start) : "";
    const after = slashRange ? prompt.value.slice(slashRange.end) : prompt.value;
    prompt.value = before + "/compare " + after.replace(/^\s+/, "");
    const caret = before.length + "/compare ".length;
    prompt.selectionStart = prompt.selectionEnd = caret;
    closeSlashPicker();
    autoGrow();
    prompt.focus();
    return;
  }
  if (command.orchestrate) {
    const before = slashRange ? prompt.value.slice(0, slashRange.start) : "";
    const after = slashRange ? prompt.value.slice(slashRange.end) : prompt.value;
    prompt.value = before + "/orchestrate " + after.replace(/^\s+/, "");
    const caret = before.length + "/orchestrate ".length;
    prompt.selectionStart = prompt.selectionEnd = caret;
    closeSlashPicker();
    autoGrow();
    prompt.focus();
    return;
  }
  if (command.commandId) {
    const before = slashRange ? prompt.value.slice(0, slashRange.start) : "";
    const after = slashRange ? prompt.value.slice(slashRange.end) : prompt.value;
    prompt.value = before + "/" + command.commandId + " " + after.replace(/^\s+/, "");
    const caret = before.length + command.commandId.length + 2;
    prompt.selectionStart = prompt.selectionEnd = caret;
    closeSlashPicker();
    autoGrow();
    prompt.focus();
    return;
  }
  if (slashRange) {
    prompt.value = prompt.value.slice(0, slashRange.start) + prompt.value.slice(slashRange.end);
    prompt.selectionStart = prompt.selectionEnd = slashRange.start;
  }
  selectRunProfile(command.profile);
  closeSlashPicker();
  autoGrow();
  prompt.focus();
}

function updateComposerSuggestions() {
  if (activeMention()) {
    requestFileResults();
    return;
  }
  closeFilePicker();
  requestSlashResults();
}

function renderFileResults() {
  filePicker.innerHTML = "";
  if (fileResults.length === 0) {
    const empty = document.createElement("div");
    empty.className = "file-empty";
    empty.textContent = i18n.noMatchingFiles;
    filePicker.appendChild(empty);
    filePicker.hidden = false;
    syncPromptSuggestionAria();
    return;
  }

  selectedFileIndex = Math.max(0, Math.min(selectedFileIndex, fileResults.length - 1));
  fileResults.forEach((file, index) => {
    const row = document.createElement("button");
    row.className = "file-result" + (index === selectedFileIndex ? " selected" : "");
    row.type = "button";
    row.tabIndex = -1;
    row.id = "file-picker-option-" + index;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", index === selectedFileIndex ? "true" : "false");
    row.title = file.path;

    const icon = document.createElement("span");
    icon.textContent = "@";
    const label = document.createElement("span");
    label.className = "file-result-label";
    label.textContent = file.label;
    const directory = document.createElement("span");
    directory.className = "file-result-path";
    directory.textContent = file.description;
    row.append(icon, label, directory);
    row.addEventListener("mousedown", (event) => event.preventDefault());
    row.addEventListener("click", () => selectFile(file));
    filePicker.appendChild(row);
  });
  filePicker.hidden = false;
  syncPromptSuggestionAria();
  filePicker.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}

function selectFile(file) {
  if (!selectedFiles.some((selected) => selected.path === file.path)) {
    selectedFiles.push(file);
  }
  if (mentionRange) {
    prompt.value = prompt.value.slice(0, mentionRange.start) + prompt.value.slice(mentionRange.end);
    prompt.selectionStart = prompt.selectionEnd = mentionRange.start;
  }
  renderMentionChips();
  closeFilePicker();
  autoGrow();
  prompt.focus();
}

function removeSelectedFile(filePath) {
  selectedFiles = selectedFiles.filter((file) => file.path !== filePath);
  renderMentionChips();
  prompt.focus();
}

function renderMentionChips() {
  mentionRow.innerHTML = "";
  mentionRow.hidden = selectedFiles.length === 0;
  for (const file of selectedFiles) {
    const chip = document.createElement("span");
    chip.className = "mention-chip";
    chip.title = file.path;

    const label = document.createElement("button");
    label.className = "mention-chip-label";
    label.type = "button";
    label.textContent = "@" + file.path;
    label.title = i18n.openFile + ": " + file.path;
    label.addEventListener("click", () => vscode.postMessage({ type: "openFile", path: file.path }));
    const remove = document.createElement("button");
    remove.className = "mention-remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = i18n.removeReference;
    remove.addEventListener("click", () => removeSelectedFile(file.path));
    chip.append(label, remove);
    mentionRow.appendChild(chip);
  }
  requestContextPreview();
}

function addTransferValue(references, value) {
  if (!value) return;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (typeof entry === "string") references.push(entry);
      }
      return;
    }
  } catch {
    // URI lists and absolute paths are commonly plain text rather than JSON.
  }
  for (const entry of value.split(/\r?\n/)) {
    const trimmed = entry.trim();
    if (trimmed && !trimmed.startsWith("#")) references.push(trimmed);
  }
}

function isUriTransferType(type) {
  const lower = String(type || "").toLowerCase();
  return lower.includes("uri-list")
    || lower === "codefiles"
    || lower === "resourceurls"
    || lower.includes("code.uri");
}

function isImageMimeType(type) {
  return String(type || "").toLowerCase().startsWith("image/");
}

function isFileDrag(transfer) {
  if (!transfer) return false;
  const types = Array.from(transfer.types || []).map((type) => String(type).toLowerCase());
  return (transfer.files?.length || 0) > 0
    || Array.from(transfer.items || []).some((item) => item.kind === "file" || isImageMimeType(item.type))
    || types.includes("files")
    || types.some(isImageMimeType)
    || types.some(isUriTransferType);
}

function transferredFiles(transfer) {
  const files = [];
  const seen = new Set();
  const addFile = (file) => {
    if (!file) return;
    const key = [file.name, file.type, file.size, file.lastModified].join("\n");
    if (seen.has(key)) return;
    seen.add(key);
    files.push(file);
  };
  for (const file of Array.from(transfer?.files || [])) addFile(file);
  for (const item of Array.from(transfer?.items || [])) {
    if (item.kind === "file" || isImageMimeType(item.type)) addFile(item.getAsFile());
  }
  return files;
}

function transferFileReferences(transfer, includePlainText) {
  const references = [];
  if (!transfer) return references;

  for (const file of transferredFiles(transfer)) {
    const filePath = file.path || file.webkitRelativePath;
    if (filePath) references.push(filePath);
  }

  const types = Array.from(transfer.types || []);
  const tried = new Set();
  for (const type of types) {
    if (!isUriTransferType(type)) continue;
    addTransferValue(references, transfer.getData(type));
    tried.add(type.toLowerCase());
  }

  // Some hosts omit MIME types from `types` even when getData still works on drop.
  for (const type of [
    "text/uri-list",
    "application/vnd.code.uri-list",
    "CodeFiles",
    "ResourceURLs",
    "codefiles",
    "resourceurls",
  ]) {
    if (tried.has(type.toLowerCase())) continue;
    try {
      const data = transfer.getData(type);
      if (data) addTransferValue(references, data);
    } catch {
      // Unsupported MIME types throw in some webview hosts.
    }
  }

  if (includePlainText && references.length === 0) {
    const plain = transfer.getData("text/plain").trim();
    if (
      plain.toLowerCase().startsWith("file:")
      || /^[a-zA-Z]:[\\/]/.test(plain)
      || /[\\/]/.test(plain)
    ) {
      addTransferValue(references, plain);
    }
  }
  return [...new Set(references)];
}

function fallbackFileName(file, index) {
  const original = String(file.name || "").trim();
  if (original) return original;
  const extension = {
    "image/avif": "avif",
    "image/bmp": "bmp",
    "image/gif": "gif",
    "image/heic": "heic",
    "image/heif": "heif",
    "image/jfif": "jfif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/svg+xml": "svg",
    "image/tiff": "tiff",
    "image/webp": "webp",
    "image/x-icon": "ico",
  }[String(file.type || "").toLowerCase()] || "bin";
  return "clipboard-image-" + String(index + 1) + "." + extension;
}

async function transferFileUploads(files) {
  const uploads = [];
  for (const [index, file] of files.slice(0, 20).entries()) {
    // Clipboard screenshots are in-memory blobs. Prefer bytes even when the
    // host stamps a non-resolvable Electron `path` onto the File object.
    const hasOsPath = Boolean(file.path || file.webkitRelativePath);
    const looksLikeClipboardImage = isImageMimeType(file.type)
      || /^image\.(png|jpe?g|gif|webp)$/i.test(String(file.name || ""))
      || /^clipboard-image-/i.test(String(file.name || ""));
    if (hasOsPath && !looksLikeClipboardImage) continue;
    if (file.size > MAX_DROPPED_FILE_BYTES) continue;
    try {
      // Send a plain number[] so hosts that still JSON-encode webview
      // messages (or mishandle TypedArrays) still revive the bytes.
      uploads.push({
        name: fallbackFileName(file, index),
        data: Array.from(new Uint8Array(await file.arrayBuffer())),
      });
    } catch {
      // The host may expose metadata without allowing the file contents to be read.
    }
  }
  return uploads;
}

function setDragActive(active) {
  composerCard.classList.toggle("drag-active", active);
}

function notifyAttachmentIdle() {
  if (pendingAttachmentResolves > 0) return;
  const waiters = attachmentResolveWaiters.splice(0, attachmentResolveWaiters.length);
  for (const resolve of waiters) resolve();
}

function markAttachmentResolveStarted() {
  pendingAttachmentResolves += 1;
}

function markAttachmentResolveFinished() {
  pendingAttachmentResolves = Math.max(0, pendingAttachmentResolves - 1);
  notifyAttachmentIdle();
}

function waitForPendingAttachments() {
  if (pendingAttachmentResolves === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      const index = attachmentResolveWaiters.indexOf(onReady);
      if (index >= 0) attachmentResolveWaiters.splice(index, 1);
      resolve(false);
    }, 15000);
    const onReady = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    attachmentResolveWaiters.push(onReady);
  });
}

async function resolveTransferredFiles(transfer, includePlainText, failureText) {
  // Capture File handles synchronously — clipboard DataTransfer clears after paste returns.
  const files = transferredFiles(transfer);
  const references = transferFileReferences(transfer, includePlainText);
  markAttachmentResolveStarted();
  try {
    const uploads = await transferFileUploads(files);
    // Prefer in-memory uploads when present (clipboard images), else path references.
    const useUploads = uploads.length > 0;
    const resolvedReferences = useUploads ? [] : references;
    if (resolvedReferences.length === 0 && uploads.length === 0) {
      status.textContent = failureText;
      markAttachmentResolveFinished();
      return;
    }
    attachmentRequestId += 1;
    vscode.postMessage({
      type: "resolveAttachments",
      requestId: attachmentRequestId,
      references: resolvedReferences,
      uploads,
    });
    // Host reply (resolvedAttachments) clears the pending gate.
  } catch {
    status.textContent = failureText;
    markAttachmentResolveFinished();
  }
}

function isNearBottom() {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 48;
}

function scrollToBottom(force = false) {
  if (!force && !followOutput) return;
  followOutput = true;
  scroller.scrollTop = scroller.scrollHeight;
}

function indexedFileReference(raw) {
  const location = /(:\d+(?::\d+)?)$/.exec(raw);
  const suffix = location ? location[1] : "";
  let filePart = suffix ? raw.slice(0, -suffix.length) : raw;

  while (filePart) {
    const normalized = filePart.replaceAll("\\", "/").replace(/^\.\//, "");
    const lower = normalized.toLowerCase();
    const hasDirectory = normalized.includes("/");
    if (workspacePaths.has(lower) || (!hasDirectory && workspaceBasenames.has(lower))) {
      return {
        display: filePart + suffix,
        reference: normalized + suffix,
      };
    }
    if (!filePart.endsWith(".")) break;
    filePart = filePart.slice(0, -1);
  }
  return undefined;
}

function linkifyWorkspaceFiles(root) {
  if (workspacePaths.size === 0) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) {
    const parent = walker.currentNode.parentElement;
    if (!parent || parent.closest("a, pre, button, .files, .user-attachments, .copy-btn")) continue;
    textNodes.push(walker.currentNode);
  }

  const fileToken = /[\p{L}\p{N}_.@+\\/-]+(?::\d+(?::\d+)?)?/gu;
  for (const textNode of textNodes) {
    const text = textNode.nodeValue || "";
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let linked = false;
    fileToken.lastIndex = 0;
    for (const match of text.matchAll(fileToken)) {
      const resolved = indexedFileReference(match[0]);
      if (!resolved || match.index === undefined) continue;
      const start = match.index;
      const end = start + resolved.display.length;
      fragment.appendChild(document.createTextNode(text.slice(lastIndex, start)));
      const link = document.createElement("a");
      link.href = "#";
      link.className = "workspace-file-link";
      link.dataset.workspaceFile = resolved.reference;
      link.title = i18n.openFile + ": " + resolved.reference;
      link.textContent = resolved.display;
      fragment.appendChild(link);
      lastIndex = end;
      linked = true;
    }
    if (linked) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
      textNode.parentNode?.replaceChild(fragment, textNode);
    }
  }
}

const COPY_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="7" height="8" rx="1"/><path d="M10.5 5.5V4.5a1 1 0 0 0-1-1h-5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h1"/></svg>';

function createCopyButton(kind, label) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "copy-btn " + (kind === "code" ? "code-copy" : "message-copy");
  btn.dataset.copy = kind;
  btn.setAttribute("aria-label", label);
  btn.title = label;
  btn.innerHTML = COPY_SVG;
  return btn;
}

function messageBody(messageNode) {
  let body = messageNode.querySelector(":scope > .message-body");
  if (!body) {
    body = document.createElement("div");
    body.className = "message-body";
    const copyBtn = messageNode.querySelector(":scope > .message-copy");
    if (copyBtn) {
      copyBtn.before(body);
    } else {
      messageNode.appendChild(body);
    }
  }
  return body;
}

function ensureMessageCopy(messageNode) {
  if (messageNode.querySelector(":scope > .message-copy")) return;
  messageNode.appendChild(createCopyButton("message", i18n.copyMessage));
}

function enhanceCodeBlocks(root) {
  for (const pre of root.querySelectorAll("pre")) {
    if (pre.parentElement?.classList.contains("code-block")) continue;
    const wrap = document.createElement("div");
    wrap.className = "code-block";
    pre.replaceWith(wrap);
    wrap.append(createCopyButton("code", i18n.copyCode), pre);
  }
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

function flashCopied(btn) {
  const prevLabel = btn.getAttribute("aria-label") || "";
  btn.classList.add("copied");
  btn.setAttribute("aria-label", i18n.copied);
  btn.title = i18n.copied;
  clearTimeout(btn._copyTimer);
  btn._copyTimer = setTimeout(() => {
    btn.classList.remove("copied");
    btn.setAttribute("aria-label", prevLabel);
    btn.title = prevLabel;
  }, 1200);
}

function copyTextForButton(btn) {
  if (btn.dataset.copy === "code") {
    return btn.closest(".code-block")?.querySelector("pre")?.innerText ?? "";
  }
  const message = btn.closest(".message");
  const body = message?.querySelector(":scope > .message-body");
  return body?.innerText?.trim() ?? "";
}

function isAllowedMarkdownImageSource(value) {
  return /^(?:https:\/\/|vscode-resource:|vscode-webview-resource:)/i.test(value)
    || /^data:image\/(?:avif|gif|jpe?g|png|webp);base64,[a-z0-9+\/=]+$/i.test(value);
}

function renderMarkdown(messageNode, raw) {
  const body = messageBody(messageNode);
  const template = document.createElement("template");
  template.innerHTML = DOMPurify.sanitize(marked.parse(raw), {
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    FORBID_ATTR: ["srcset"],
  });
  for (const image of template.content.querySelectorAll("img[src]")) {
    const src = image.getAttribute("src") ?? "";
    if (!isAllowedMarkdownImageSource(src)) image.removeAttribute("src");
  }
  body.replaceChildren(template.content);
  for (const anchor of body.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) {
      anchor.setAttribute("data-external-url", href);
      anchor.setAttribute("href", "#");
      anchor.setAttribute("title", href);
    } else if (!anchor.hasAttribute("data-workspace-file")) {
      anchor.removeAttribute("href");
    }
  }
  linkifyWorkspaceFiles(body);
  enhanceCodeBlocks(body);
  ensureMessageCopy(messageNode);
  reapplyFindIfActive();
}

function addUserMessage(text, attachments = []) {
  const node = document.createElement("div");
  node.className = "message user";
  const body = document.createElement("div");
  body.className = "message-body";
  body.textContent = text;
  node.appendChild(body);
  linkifyWorkspaceFiles(body);
  if (attachments.length > 0) {
    const attachmentsNode = document.createElement("div");
    attachmentsNode.className = "user-attachments";
    for (const file of attachments) {
      const chip = document.createElement("button");
      chip.className = "user-attachment";
      chip.type = "button";
      chip.textContent = "@" + (file.label || file.path);
      chip.title = i18n.openFile + ": " + file.path;
      chip.addEventListener("click", () => vscode.postMessage({ type: "openFile", path: file.path }));
      attachmentsNode.appendChild(chip);
    }
    node.appendChild(attachmentsNode);
  }
  ensureMessageCopy(node);
  messages.appendChild(node);
  scrollToBottom();
  return node;
}

function progressSummary(state, count) {
  const label = state === "running"
    ? i18n.progressRunning
    : state === "stopped"
      ? i18n.progressStopped
      : state === "error"
        ? i18n.progressFailed
        : i18n.progressCompleted;
  return count > 0 ? label + " · " + count + " " + i18n.progressStep : label;
}

function setProgressRow(panel, step) {
  panel.empty?.remove();
  panel.empty = undefined;
  let row = panel.rows.get(step.id);
  if (!row) {
    const node = document.createElement("div");
    const statusNode = document.createElement("span");
    statusNode.className = "progress-status";
    const textNode = document.createElement("span");
    textNode.className = "progress-text";
    node.append(statusNode, textNode);
    panel.list.appendChild(node);
    row = { node, statusNode, textNode };
    panel.rows.set(step.id, row);
  }
  row.node.className = "progress-item " + step.status;
  row.statusNode.textContent = step.status === "completed"
    ? "✓"
    : step.status === "error" ? "!" : step.status === "stopped" ? "■" : "";
  row.textNode.textContent = step.text;
  panel.summaryText.textContent = progressSummary(panel.state, panel.rows.size);
}

function createProgressPanel(steps = [], state = "running") {
  const node = document.createElement("details");
  node.className = "chat-progress" + (state === "running" ? " running" : "");
  node.open = state === "error" || state === "stopped";
  const summary = document.createElement("summary");
  const spinner = document.createElement("span");
  spinner.className = "progress-spinner";
  spinner.setAttribute("aria-hidden", "true");
  const summaryText = document.createElement("span");
  summaryText.textContent = progressSummary(state, steps.length);
  summary.append(spinner, summaryText);
  const list = document.createElement("div");
  list.className = "progress-list";
  const panel = { node, summaryText, list, rows: new Map(), state, empty: undefined };
  node.append(summary, list);
  if (steps.length === 0) {
    const empty = document.createElement("div");
    empty.className = "progress-empty";
    empty.textContent = i18n.progressPreparing;
    list.appendChild(empty);
    panel.empty = empty;
  } else {
    for (const step of steps) setProgressRow(panel, step);
  }
  return panel;
}

function beginProgress() {
  if (view !== "chat" || !assistantNode) return;
  activeProgress = createProgressPanel();
  assistantNode.before(activeProgress.node);
  scrollToBottom();
}

function updateProgress(data) {
  if (view !== "chat") return;
  if (!activeProgress) beginProgress();
  if (!activeProgress) return;
  setProgressRow(activeProgress, {
    id: data.callId || data.text,
    text: data.text,
    status: data.status || "running",
  });
  scrollToBottom();
}

function finishProgress(state) {
  const announcement = state === "completed"
    ? i18n.progressCompleted
    : state === "stopped"
      ? i18n.progressStopped
      : i18n.progressFailed;
  announcePolite(announcement);
  if (!activeProgress) return;
  activeProgress.state = state;
  activeProgress.node.classList.remove("running");
  for (const row of activeProgress.rows.values()) {
    if (row.node.classList.contains("running")) {
      row.node.className = "progress-item " + (state === "completed" ? "completed" : state);
      row.statusNode.textContent = state === "completed" ? "✓" : state === "stopped" ? "■" : "!";
    }
  }
  activeProgress.summaryText.textContent = progressSummary(state, activeProgress.rows.size);
  activeProgress.node.open = state !== "completed";
}

function addAssistantMessage(
  raw,
  isError = false,
  files = [],
  progress = [],
  progressState = "completed",
  recoveryActions,
) {
  const node = document.createElement("div");
  node.className = "message assistant" + (isError ? " error" : "");
  if (raw) {
    renderMarkdown(node, raw);
  } else {
    messageBody(node);
    ensureMessageCopy(node);
  }
  if (progress.length > 0) {
    messages.appendChild(createProgressPanel(progress, progressState).node);
  }
  messages.appendChild(node);
  for (const file of files) addFileChip(node, file.path, file.label);
  if (isError) renderRecoveryActions(node, recoveryActions);
  scrollToBottom();
  return node;
}

function addFileChip(messageNode, filePath, label) {
  let filesNode = messageNode.nextElementSibling;
  if (!filesNode || !filesNode.classList.contains("files")) {
    filesNode = document.createElement("div");
    filesNode.className = "files";
    messageNode.after(filesNode);
  }
  const chip = document.createElement("button");
  chip.className = "file-chip";
  chip.type = "button";
  chip.textContent = label;
  chip.title = i18n.showDiff + ": " + filePath;
  chip.addEventListener("click", () => vscode.postMessage({ type: "openDiff", path: filePath }));
  filesNode.appendChild(chip);
}

const DEFAULT_RECOVERY_ACTIONS = ["retry", "diagnostics", "runCenter"];
const RECOVERY_ACTION_LABELS = {
  retry: () => i18n.recoveryRetry,
  diagnostics: () => i18n.recoveryExportDiagnostics,
  runCenter: () => i18n.recoveryOpenRunCenter,
  logs: () => i18n.recoveryOpenLogs,
};

function renderRecoveryActions(messageNode, actions) {
  const resolved =
    Array.isArray(actions) && actions.length > 0
      ? actions.filter((action) => Object.prototype.hasOwnProperty.call(RECOVERY_ACTION_LABELS, action))
      : DEFAULT_RECOVERY_ACTIONS;
  if (resolved.length === 0) return;

  let insertAfter = messageNode;
  if (messageNode.nextElementSibling?.classList.contains("files")) {
    insertAfter = messageNode.nextElementSibling;
  }
  let actionsNode = insertAfter.nextElementSibling;
  if (!actionsNode || !actionsNode.classList.contains("error-actions")) {
    actionsNode = document.createElement("div");
    actionsNode.className = "error-actions";
    insertAfter.after(actionsNode);
  } else {
    actionsNode.replaceChildren();
  }

  for (const action of resolved) {
    const button = document.createElement("button");
    button.className = "error-action";
    button.type = "button";
    button.textContent = RECOVERY_ACTION_LABELS[action]();
    button.addEventListener("click", () =>
      vscode.postMessage({ type: "runRecoveryAction", action }),
    );
    actionsNode.appendChild(button);
  }
}

function autoGrow() {
  prompt.style.height = "auto";
  prompt.style.height = Math.min(prompt.scrollHeight, 200) + "px";
}

function renderQueue() {
  queueRow.innerHTML = "";
  queueRow.hidden = queuedMessages.length === 0;
  if (queuedMessages.length === 0) {
    selectedQueueIds = new Set();
    return;
  }

  const visibleIds = new Set(queuedMessages.map((item) => item.id));
  selectedQueueIds = new Set(
    [...selectedQueueIds].filter((id) => visibleIds.has(id)),
  );
  const parallelSlotsOpen = activeChatRuns < maximumChatRuns;
  const selectableItems = queuedMessages.filter((item) => item.kind !== "interrupt");
  const selectedCount = selectableItems.filter((item) => selectedQueueIds.has(item.id)).length;

  const headingRow = document.createElement("div");
  headingRow.className = "queue-heading-row";
  const heading = document.createElement("div");
  heading.className = "queue-heading";
  heading.textContent = i18n.queuedMessages + " (" + queuedMessages.length + ")";
  headingRow.appendChild(heading);
  if (selectableItems.length > 0) {
    const runSelected = document.createElement("button");
    runSelected.className = "queue-run-selected";
    runSelected.type = "button";
    runSelected.textContent = i18n.runSelectedParallel;
    runSelected.title = i18n.runSelectedParallelTitle;
    runSelected.disabled = selectedCount === 0 || !parallelSlotsOpen;
    if (!parallelSlotsOpen) {
      runSelected.title = i18n.parallelLimitReached
        + " (" + activeChatRuns + "/" + maximumChatRuns + ")";
    }
    runSelected.addEventListener("click", () => {
      const ids = selectableItems
        .filter((item) => selectedQueueIds.has(item.id))
        .map((item) => item.id);
      if (ids.length === 0) return;
      selectedQueueIds = new Set();
      vscode.postMessage({ type: "launchQueuedParallel", ids });
    });
    headingRow.appendChild(runSelected);
  }
  queueRow.appendChild(headingRow);

  for (const item of queuedMessages) {
    const row = document.createElement("div");
    row.className = "queue-item " + (item.kind === "interrupt" ? "interrupt" : "queued");
    const canLaunchParallel = item.kind !== "interrupt";

    if (canLaunchParallel) {
      const select = document.createElement("input");
      select.className = "queue-select";
      select.type = "checkbox";
      select.checked = selectedQueueIds.has(item.id);
      select.title = i18n.selectQueued;
      select.setAttribute("aria-label", i18n.selectQueued);
      select.addEventListener("change", () => {
        if (select.checked) {
          selectedQueueIds.add(item.id);
        } else {
          selectedQueueIds.delete(item.id);
        }
        renderQueue();
      });
      row.appendChild(select);
    }

    const kind = document.createElement("span");
    kind.className = "queue-kind";
    kind.textContent = item.kind === "interrupt" ? i18n.interruptQueued : i18n.queued;
    row.appendChild(kind);

    const text = document.createElement("span");
    text.className = "queue-text";
    text.textContent = item.prompt;
    text.title = item.prompt;
    row.appendChild(text);

    if (canLaunchParallel) {
      const parallel = document.createElement("button");
      parallel.className = "queue-parallel";
      parallel.type = "button";
      parallel.textContent = "⧉";
      parallel.title = parallelSlotsOpen
        ? i18n.runQueuedParallel
        : i18n.parallelLimitReached + " (" + activeChatRuns + "/" + maximumChatRuns + ")";
      parallel.setAttribute("aria-label", i18n.runQueuedParallel);
      parallel.disabled = !parallelSlotsOpen;
      parallel.addEventListener("click", (event) => {
        event.stopPropagation();
        selectedQueueIds.delete(item.id);
        vscode.postMessage({ type: "launchQueuedParallel", id: item.id });
      });
      row.appendChild(parallel);
    }

    const remove = document.createElement("button");
    remove.className = "queue-remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = i18n.removeQueued;
    remove.addEventListener("click", () => {
      selectedQueueIds.delete(item.id);
      vscode.postMessage({ type: "removeQueuedMessage", id: item.id });
    });
    row.appendChild(remove);
    queueRow.appendChild(row);
  }
}

function messagePayload(type, text, files, commandId) {
  return {
    type,
    prompt: text,
    attachContext: attach,
    files: files.map((file) => file.path),
    modelId: selectedModelId,
    modelParams: selectedModelDefinition()
      ? paramsForModel(selectedModelDefinition())
      : [],
    profile: runProfile,
    skills: selectedSkills.slice(),
    commandId,
    includeProjectMemory,
  };
}

function clearComposerMessage() {
  prompt.value = "";
  selectedFiles = [];
  renderMentionChips();
  closeFilePicker();
  closeSlashPicker();
  autoGrow();
}

function ensureRunningAudioContext() {
  if (runningAudioContext) return runningAudioContext;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return undefined;
  runningAudioContext = new AudioContextClass();
  return runningAudioContext;
}

function primeRunningSound() {
  if (!runningSoundEnabled && !completionSoundEnabled && !errorSoundEnabled) return;
  const audio = ensureRunningAudioContext();
  if (audio?.state === "suspended") {
    void audio.resume().catch(() => {});
  }
}

function scheduleRunningSound(delay = 5000) {
  if (!running || !runningSoundEnabled || runningSoundTimer) return;
  runningSoundTimer = setTimeout(() => {
    runningSoundTimer = undefined;
    playRunningSound();
  }, delay);
}

function playRunningSound() {
  if (!running || !runningSoundEnabled) return;
  const audio = ensureRunningAudioContext();
  if (!audio) return;

  const playPulse = () => {
    if (!running || !runningSoundEnabled || audio.state !== "running") return;
    const now = audio.currentTime;
    const playTone = (frequency, start, duration, volume) => {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const voice = { oscillator, gain };
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume, start + 0.16);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.addEventListener("ended", () => {
        runningSoundVoices.delete(voice);
        oscillator.disconnect();
        gain.disconnect();
      }, { once: true });
      runningSoundVoices.add(voice);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.01);
    };
    playTone(261.63, now, 0.5, 0.025);
    playTone(329.63, now + 0.16, 0.65, 0.019);
  };

  if (audio.state === "suspended") {
    void audio.resume().then(playPulse).catch(() => {});
  } else {
    playPulse();
  }
  scheduleRunningSound();
}

function startRunningSound() {
  if (!runningSoundEnabled) return;
  primeRunningSound();
  playRunningSound();
}

function stopRunningSound() {
  if (runningSoundTimer) {
    clearTimeout(runningSoundTimer);
    runningSoundTimer = undefined;
  }
  for (const voice of runningSoundVoices) {
    try {
      voice.oscillator.stop();
    } catch {
      // The oscillator may already have ended between iteration and stop().
    }
    voice.oscillator.disconnect();
    voice.gain.disconnect();
  }
  runningSoundVoices.clear();
}

function playCompletionSound() {
  if (!completionSoundEnabled) return;
  const audio = ensureRunningAudioContext();
  if (!audio) return;

  const playChime = () => {
    if (!completionSoundEnabled || audio.state !== "running") return;
    const now = audio.currentTime;
    const playTone = (frequency, start, duration, volume) => {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.addEventListener("ended", () => {
        oscillator.disconnect();
        gain.disconnect();
      }, { once: true });
      oscillator.start(start);
      oscillator.stop(start + duration + 0.01);
    };
    playTone(392, now, 0.3, 0.025);
    playTone(523.25, now + 0.14, 0.34, 0.022);
    playTone(659.25, now + 0.3, 0.4, 0.019);
  };

  if (audio.state === "suspended") {
    void audio.resume().then(playChime).catch(() => {});
  } else {
    playChime();
  }
}

function playErrorSound() {
  if (!errorSoundEnabled) return;
  const audio = ensureRunningAudioContext();
  if (!audio) return;

  const playAlert = () => {
    if (!errorSoundEnabled || audio.state !== "running") return;
    const now = audio.currentTime;
    const playTone = (frequency, start, duration, volume) => {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.addEventListener("ended", () => {
        oscillator.disconnect();
        gain.disconnect();
      }, { once: true });
      oscillator.start(start);
      oscillator.stop(start + duration + 0.01);
    };
    playTone(415.3, now, 0.28, 0.028);
    playTone(311.13, now + 0.16, 0.3, 0.026);
    playTone(233.08, now + 0.34, 0.42, 0.024);
  };

  if (audio.state === "suspended") {
    void audio.resume().then(playAlert).catch(() => {});
  } else {
    playAlert();
  }
}

document.addEventListener("pointerdown", primeRunningSound, { once: true });
document.addEventListener("keydown", primeRunningSound, { once: true });
scroller.addEventListener("scroll", () => {
  followOutput = isNearBottom();
}, { passive: true });

async function submitMessage(action = "send") {
  const attachmentsReady = await waitForPendingAttachments();
  if (!attachmentsReady) {
    // Do not clear the draft or enqueue a message without its pending attachments.
    // A later host reply still updates selectedFiles, so the user can retry safely.
    status.textContent = i18n.attachmentResolveTimeout;
    prompt.focus();
    return;
  }
  const consumed = consumeLeadingSlashCommand(prompt.value.trim());
  if (consumed.profile) {
    runProfile = consumed.profile;
    updateProfileChip();
  }
  const text = consumed.text;
  const files = selectedFiles.slice();
  if (!text && !consumed.commandId && files.length === 0) {
    if (consumed.profile) {
      prompt.value = "";
      closeSlashPicker();
      autoGrow();
    }
    return;
  }
  const displayText = consumed.bestOfN
    ? (text ? "/compare " + text : "/compare")
    : consumed.orchestrate
      ? (text ? "/orchestrate " + text : "/orchestrate")
    : consumed.commandId
      ? (text ? "/" + consumed.commandId + " " + text : "/" + consumed.commandId)
      : (text || (files.length > 0 ? i18n.attachedImagePrompt : text));

  if (consumed.bestOfN) {
    if (!text) {
      return;
    }
    showChat();
    followOutput = true;
    addUserMessage(displayText, files);
    assistantRaw = "";
    assistantNode = addAssistantMessage("");
    clearComposerMessage();
    primeRunningSound();
    vscode.postMessage(messagePayload("startBestOfN", text, files));
    return;
  }

  if (consumed.orchestrate) {
    if (!text) {
      return;
    }
    showChat();
    followOutput = true;
    addUserMessage(displayText, files);
    assistantRaw = "";
    assistantNode = addAssistantMessage("");
    clearComposerMessage();
    primeRunningSound();
    vscode.postMessage(messagePayload("startOrchestrate", text, files));
    return;
  }

  const sendText = text || (files.length > 0 ? i18n.attachedImagePrompt : text);
  if (running) {
    const type = action === "interrupt" ? "interruptMessage" : "queueMessage";
    clearComposerMessage();
    vscode.postMessage(messagePayload(type, sendText, files, consumed.commandId));
    prompt.focus();
    return;
  }

  showChat();
  followOutput = true;
  addUserMessage(displayText, files);
  assistantRaw = "";
  assistantNode = addAssistantMessage("");
  clearComposerMessage();
  primeRunningSound();
  vscode.postMessage(messagePayload("send", sendText, files, consumed.commandId));
}

sendButton.addEventListener("click", () => {
  if (running) {
    vscode.postMessage({ type: "cancel" });
  } else {
    submitMessage();
  }
});
queueButton.addEventListener("click", () => submitMessage("queue"));
interruptButton.addEventListener("click", () => submitMessage("interrupt"));
newChatButton.addEventListener("click", () => vscode.postMessage({ type: "newChat" }));
startParallelAgentButton.addEventListener("click", () => {
  if (!startParallelAgentButton.disabled) {
    vscode.postMessage({ type: "newChat" });
  }
});
historyButton.addEventListener("click", () => vscode.postMessage({ type: "showHome" }));
moreButton.addEventListener("click", () => setMoreMenuOpen(moreMenu.hidden));
featureSettingsButton.addEventListener("click", () => {
  setMoreMenuOpen(false);
  vscode.postMessage({ type: "openSettings" });
});
soundButton.addEventListener("click", (event) => {
  event.stopPropagation();
  setSoundMenuOpen(soundMenu.hidden);
});
parallelBarToggle.addEventListener("click", () => {
  setParallelBarExpanded(!parallelBarExpanded);
});
notificationToggle.addEventListener("change", () => {
  vscode.postMessage({
    type: "setAlertSetting",
    setting: "notifyOnComplete",
    enabled: notificationToggle.checked,
  });
});
runningSoundToggle.addEventListener("change", () => {
  if (webviewSoundPlayback) {
    runningSoundEnabled = runningSoundToggle.checked;
    if (runningSoundEnabled && running) {
      startRunningSound();
    } else {
      stopRunningSound();
    }
  }
  vscode.postMessage({
    type: "setAlertSetting",
    setting: "playSoundWhileRunning",
    enabled: runningSoundToggle.checked,
  });
});
completionSoundToggle.addEventListener("change", () => {
  if (webviewSoundPlayback) {
    completionSoundEnabled = completionSoundToggle.checked;
    if (completionSoundEnabled) primeRunningSound();
  }
  vscode.postMessage({
    type: "setAlertSetting",
    setting: "playSoundOnComplete",
    enabled: completionSoundToggle.checked,
  });
});
errorSoundToggle.addEventListener("change", () => {
  if (webviewSoundPlayback) {
    errorSoundEnabled = errorSoundToggle.checked;
    if (errorSoundEnabled) primeRunningSound();
  }
  vscode.postMessage({
    type: "setAlertSetting",
    setting: "playSoundOnError",
    enabled: errorSoundToggle.checked,
  });
});
viewAll.addEventListener("click", () => {
  tasksExpanded = true;
  renderTasks();
});
taskSearch.addEventListener("input", () => {
  conversationSearchQuery = taskSearch.value;
  clearTimeout(conversationSearchTimer);
  conversationSearchTimer = setTimeout(() => {
    vscode.postMessage({ type: "searchConversations", query: conversationSearchQuery });
  }, 180);
});
attachButton.addEventListener("click", () => {
  if (addMenu.hidden || addMenuLauncher !== attachButton) {
    openAddMenu(attachButton);
  } else {
    closeAddMenu();
  }
});
profileChip.addEventListener("click", () => {
  if (addMenu.hidden || addMenuLauncher !== profileChip) {
    openAddMenu(profileChip);
  } else {
    closeAddMenu();
  }
});
addMenu.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeAddMenu({ restoreFocus: true });
    return;
  }
  const items = enabledAddMenuItems();
  if (items.length === 0) return;
  const currentIndex = Math.max(0, items.indexOf(document.activeElement));
  let nextIndex;
  if (event.key === "ArrowDown") {
    nextIndex = (currentIndex + 1) % items.length;
  } else if (event.key === "ArrowUp") {
    nextIndex = (currentIndex - 1 + items.length) % items.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = items.length - 1;
  } else if (event.key === "Tab") {
    closeAddMenu({ restoreFocus: true });
    return;
  } else {
    return;
  }
  event.preventDefault();
  focusAddMenuItem(nextIndex);
});
ctxRemove.addEventListener("click", () => setAttach(false));
compareClose.addEventListener("click", () => {
  renderCompare(null);
});
orchestratorClose.addEventListener("click", () => {
  renderOrchestratorDetail(null);
});
memoryChip.addEventListener("click", () => {
  setIncludeProjectMemory(!includeProjectMemory);
  requestContextPreview();
});
setIncludeProjectMemory(true);
approvalSelect.addEventListener("change", () => {
  setApprovalMode(approvalSelect.value);
  vscode.postMessage({ type: "selectApprovalMode", approvalMode: approvalSelect.value });
});
if (sandboxBannerToggle) {
  sandboxBannerToggle.addEventListener("click", () => {
    setSandboxBannerExpanded(!sandboxBannerExpanded);
  });
}
if (sandboxBannerLearnMore) {
  sandboxBannerLearnMore.addEventListener("click", () => {
    vscode.postMessage({ type: "sandboxLearnMore" });
  });
}
modelButton.addEventListener("click", () => {
  if (modelPicker.hidden) {
    openModelPicker();
  } else {
    closeModelPicker();
  }
});
modelSearch.addEventListener("input", renderModelList);
window.addEventListener("resize", positionModelPicker);
window.addEventListener("blur", () => {
  closeModelPicker();
  closeAddMenu();
  setMoreMenuOpen(false);
  setSandboxBannerExpanded(false);
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    closeModelPicker();
    closeAddMenu();
    setMoreMenuOpen(false);
    setSandboxBannerExpanded(false);
  }
});
document.addEventListener("pointerdown", (event) => {
  if (!modelPicker.hidden && !document.querySelector(".model-control").contains(event.target)) {
    closeModelPicker();
  }
  if (!addMenu.hidden && !document.querySelector(".add-control").contains(event.target)) {
    closeAddMenu();
  }
  if (!moreMenu.hidden && !document.querySelector(".more-control").contains(event.target)) {
    setMoreMenuOpen(false);
  }
  if (
    sandboxBanner
    && !sandboxBanner.hidden
    && !document.querySelector(".sandbox-control")?.contains(event.target)
  ) {
    setSandboxBannerExpanded(false);
  }
});
findInChatButton.addEventListener("click", () => openFindBar());
chatFindPrev.addEventListener("click", () => gotoFindMatch(-1));
chatFindNext.addEventListener("click", () => gotoFindMatch(1));
chatFindClose.addEventListener("click", () => closeFindBar());
chatFindInput.addEventListener("input", () => scheduleFind());
chatFindInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    gotoFindMatch(event.shiftKey ? -1 : 1);
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeFindBar();
  }
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && String(event.key).toLowerCase() === "f") {
    if (view === "chat") {
      event.preventDefault();
      openFindBar();
    }
    return;
  }
  if (event.key === "Escape" && findBarOpen) {
    event.preventDefault();
    closeFindBar();
  } else if (event.key === "Escape" && !modelPicker.hidden) {
    event.preventDefault();
    closeModelPicker();
    modelButton.focus();
  } else if (event.key === "Escape" && !addMenu.hidden) {
    event.preventDefault();
    closeAddMenu({ restoreFocus: true });
  } else if (event.key === "Escape" && !soundMenu.hidden) {
    event.preventDefault();
    setSoundMenuOpen(false);
    soundButton.focus();
  } else if (event.key === "Escape" && !moreMenu.hidden) {
    event.preventDefault();
    setMoreMenuOpen(false);
    moreButton.focus();
  }
});
document.getElementById("keyButton").addEventListener("click", () => {
  setMoreMenuOpen(false);
  vscode.postMessage({ type: "setApiKey" });
});
showSetupChecklistButton.addEventListener("click", () => {
  setMoreMenuOpen(false);
  checklistForcedOpen = true;
  vscode.postMessage({ type: "showSetupChecklist" });
});
setupChecklistDismiss.addEventListener("click", () => {
  vscode.postMessage({ type: "dismissSetupChecklist" });
});
authChip.addEventListener("click", () => vscode.postMessage({ type: "setApiKey" }));
document.getElementById("connectButton").addEventListener("click", () => vscode.postMessage({ type: "setApiKey" }));
document.getElementById("dashboardButton").addEventListener("click", () => vscode.postMessage({ type: "openDashboard" }));
workspaceLabel.addEventListener("click", () => {
  if (workspaceLabel.disabled || !workspaceLabel.classList.contains("selectable")) return;
  vscode.postMessage({ type: "pickWorkspaceFolder" });
});
messages.addEventListener("click", (event) => {
  const el = event.target instanceof Element ? event.target : null;
  const copyBtn = el?.closest("[data-copy]");
  if (copyBtn instanceof HTMLButtonElement) {
    event.preventDefault();
    const text = copyTextForButton(copyBtn);
    if (!text) return;
    void writeClipboard(text).then((ok) => {
      if (ok) flashCopied(copyBtn);
    });
    return;
  }

  const external = el?.closest("[data-external-url]");
  if (external instanceof HTMLElement && external.dataset.externalUrl) {
    event.preventDefault();
    vscode.postMessage({ type: "openExternal", path: external.dataset.externalUrl });
    return;
  }

  const target = el?.closest("[data-workspace-file]");
  if (!(target instanceof HTMLElement) || !target.dataset.workspaceFile) return;
  event.preventDefault();
  vscode.postMessage({ type: "openReferencedFile", path: target.dataset.workspaceFile });
});
// VS Code disables webview pointer events during resource drags unless Shift is held.
// Listen on document so the whole view accepts drops once Shift re-enables the webview.
document.addEventListener("dragenter", (event) => {
  if (!isFileDrag(event.dataTransfer)) return;
  event.preventDefault();
  setDragActive(true);
});
document.addEventListener("dragover", (event) => {
  if (!isFileDrag(event.dataTransfer)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  setDragActive(true);
});
document.addEventListener("dragleave", (event) => {
  const related = event.relatedTarget;
  if (related instanceof Node && document.documentElement.contains(related)) return;
  setDragActive(false);
});
document.addEventListener("drop", (event) => {
  if (!isFileDrag(event.dataTransfer)) return;
  event.preventDefault();
  setDragActive(false);
  void resolveTransferredFiles(event.dataTransfer, true, i18n.dropFailed);
});
window.addEventListener("dragend", () => setDragActive(false));
window.addEventListener("blur", () => setDragActive(false));
let restorePromptOnWindowFocus = false;
let promptFocusRestoreGeneration = 0;

function restorePromptFocusNow() {
  if (
    !restorePromptOnWindowFocus
    || !document.hasFocus()
    || document.activeElement === prompt
  ) {
    return;
  }
  prompt.focus({ preventScroll: true });
}

function restorePromptFocusFromHost() {
  if (!restorePromptOnWindowFocus) return false;
  // The extension host sees the native VS Code window regain focus before
  // the webview document necessarily reports it. Only that host signal may
  // bypass document.hasFocus(); scheduled retries keep the stricter guard.
  if (!document.hasFocus() || document.activeElement !== prompt) {
    prompt.focus({ preventScroll: true });
  }
  return true;
}

function schedulePromptFocusRestore() {
  restorePromptOnWindowFocus = true;
  const generation = ++promptFocusRestoreGeneration;
  const restore = () => {
    if (generation !== promptFocusRestoreGeneration) return;
    restorePromptFocusNow();
  };
  requestAnimationFrame(restore);
  // Typeless may return focus after its paste/input event has completed.
  // Retry across that hand-off instead of relying on a single animation frame.
  for (const delay of [50, 150, 350, 700, 1200, 2000]) {
    setTimeout(restore, delay);
  }
}

function cancelPromptFocusRestore() {
  restorePromptOnWindowFocus = false;
  promptFocusRestoreGeneration += 1;
}

// Dictation tools briefly move focus to a system-level voice bar. Remember
// that the prompt was the target and restore its caret when the webview
// becomes active again. Pointer interaction inside the webview cancels the
// restoration so an intentional click never has its focus stolen.
prompt.addEventListener("focus", () => {
  restorePromptOnWindowFocus = true;
});
prompt.addEventListener("blur", (event) => {
  if (event.relatedTarget instanceof Node && document.contains(event.relatedTarget)) {
    cancelPromptFocusRestore();
  } else {
    // Typeless can move focus outside the webview after the text has already
    // arrived, so start a fresh retry window from the actual focus loss.
    schedulePromptFocusRestore();
  }
});
document.addEventListener("pointerdown", (event) => {
  if (event.target !== prompt) cancelPromptFocusRestore();
}, true);
window.addEventListener("blur", () => {
  if (document.activeElement === prompt) restorePromptOnWindowFocus = true;
});
window.addEventListener("focus", () => {
  if (!restorePromptOnWindowFocus) return;
  // Restore synchronously before a dictation tool delivers its paste/input
  // during the same native focus hand-off. The scheduled retries still
  // cover tools that move focus again after the window focus event.
  restorePromptFocusNow();
  schedulePromptFocusRestore();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden || !restorePromptOnWindowFocus) return;
  restorePromptFocusNow();
  schedulePromptFocusRestore();
});
prompt.addEventListener("paste", (event) => {
  const clipboard = event.clipboardData;
  const plain = clipboard?.getData("text/plain") ?? "";
  const hasImagePayload = Boolean(
    clipboard
    && (
      Array.from(clipboard.items || []).some((item) => isImageMimeType(item.type))
      || Array.from(clipboard.types || []).some(isImageMimeType)
      || Array.from(clipboard.files || []).some((file) => isImageMimeType(file.type))
    ),
  );
  // Screenshots must win even when the clipboard also carries text/HTML.
  if (hasImagePayload && isFileDrag(clipboard)) {
    event.preventDefault();
    void resolveTransferredFiles(clipboard, false, i18n.pasteFailed);
    return;
  }
  // Voice tools like Typeless paste polished text. Prefer that over file-drag
  // heuristics, which can otherwise swallow the paste when clipboard also
  // advertises file/URI payloads.
  if (plain.length > 0) {
    schedulePromptFocusRestore();
    return;
  }
  if (!isFileDrag(clipboard)) return;
  event.preventDefault();
  void resolveTransferredFiles(clipboard, false, i18n.pasteFailed);
});
prompt.addEventListener("input", () => {
  autoGrow();
  updateComposerSuggestions();
  schedulePromptFocusRestore();
  requestContextPreview();
});
prompt.addEventListener("compositionend", () => {
  autoGrow();
  updateComposerSuggestions();
  requestContextPreview();
});
prompt.addEventListener("click", updateComposerSuggestions);
function isTypelessHotkey(event) {
  return event.code === "AltRight"
    && event.key !== "AltGraph"
    && !event.ctrlKey
    && !event.metaKey
    && !event.shiftKey;
}
function reportTypelessHotkey() {
  vscode.postMessage({
    type: "promptDictationHotkey",
    occurredAt: Date.now(),
  });
}
prompt.addEventListener("keydown", (event) => {
  // Observe Typeless's Windows default without suppressing the key. AltGr
  // reports AltGraph and/or Ctrl+Alt, so international input stays intact.
  if (isTypelessHotkey(event)) reportTypelessHotkey();
  // Dictation / IME confirmation uses Enter and keyCode 229; never treat as send.
  if (event.isComposing || event.keyCode === 229) return;
  if (!filePicker.hidden) {
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && fileResults.length > 0) {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      selectedFileIndex = (selectedFileIndex + direction + fileResults.length) % fileResults.length;
      renderFileResults();
      return;
    }
    if ((event.key === "Enter" || event.key === "Tab") && fileResults.length > 0) {
      event.preventDefault();
      selectFile(fileResults[selectedFileIndex]);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeFilePicker();
      return;
    }
  }
  if (!slashPicker.hidden) {
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && slashResults.length > 0) {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      selectedSlashIndex = (selectedSlashIndex + direction + slashResults.length) % slashResults.length;
      renderSlashResults();
      return;
    }
    if ((event.key === "Enter" || event.key === "Tab") && slashResults.length > 0) {
      event.preventDefault();
      selectSlashCommand(slashResults[selectedSlashIndex]);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeSlashPicker();
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (running && event.ctrlKey) {
      submitMessage("interrupt");
    } else if (running) {
      submitMessage("queue");
    } else {
      submitMessage();
    }
  }
});

window.addEventListener("message", ({ data }) => {
  switch (data.type) {
    case "hostWindowFocused":
      if (restorePromptFocusFromHost()) schedulePromptFocusRestore();
      break;
    case "authState":
      auth.style.display = data.configured ? "none" : "block";
      authChip.style.display = data.configured ? "none" : "inline-flex";
      status.textContent = data.configured ? i18n.connected : i18n.apiKeyMissing;
      break;
    case "authRequired":
      auth.style.display = "block";
      authChip.style.display = "inline-flex";
      break;
    case "setupChecklistState":
      renderSetupChecklist(data);
      break;
    case "focusApprovalModeMenu":
      focusApprovalModeMenu();
      break;
    case "notificationAndSoundSettings":
      notificationToggle.checked = data.notification === true;
      runningSoundToggle.checked = data.running === true;
      completionSoundToggle.checked = data.completion === true;
      errorSoundToggle.checked = data.error === true;
      webviewSoundPlayback = data.webviewPlayback === true;
      break;
    case "runningSoundSetting":
      runningSoundEnabled = data.enabled === true;
      if (runningSoundEnabled && running) {
        startRunningSound();
      } else {
        stopRunningSound();
      }
      break;
    case "completionSoundSetting":
      completionSoundEnabled = data.enabled === true;
      break;
    case "errorSoundSetting":
      errorSoundEnabled = data.enabled === true;
      break;
    case "workspace":
      if (data.name) workspaceLabel.textContent = data.name + " " + i18n.runningIn;
      const selectable = data.selectable === true;
      workspaceLabel.classList.toggle("selectable", selectable);
      workspaceLabel.disabled = !selectable;
      workspaceLabel.title = selectable ? i18n.selectWorkspace : "";
      workspaceLabel.setAttribute("aria-label", selectable
        ? (data.name ? data.name + " — " + i18n.selectWorkspace : i18n.selectWorkspace)
        : (data.name || i18n.localRun));
      break;
    case "workspaceFileIndex":
      workspacePaths = new Set((data.files || []).map((file) => file.toLowerCase()));
      workspaceBasenames = new Set(
        (data.files || []).map((file) => file.split(/[\\/]/).pop().toLowerCase()),
      );
      linkifyWorkspaceFiles(messages);
      break;
    case "contextInfo":
      if (attach) updateContextChip(data.label);
      break;
    case "fileResults":
      if (data.requestId !== fileRequestId || !activeMention()) break;
      fileResults = (data.files || []).filter(
        (file) => !selectedFiles.some((selected) => selected.path === file.path),
      );
      renderFileResults();
      break;
    case "resolvedAttachments":
      if (data.requestId === attachmentRequestId) {
        for (const file of data.files || []) {
          if (!selectedFiles.some((selected) => selected.path === file.path)) {
            selectedFiles.push(file);
          }
        }
        renderMentionChips();
        prompt.focus();
      }
      markAttachmentResolveFinished();
      break;
    case "integrations":
      availableSkills = data.skills || [];
      availableMcpServers = data.mcpServers || [];
      projectCommands = data.commands || [];
      selectedSkills = selectedSkills.filter((name) =>
        availableSkills.some((skill) => skill.name === name));
      updateProfileChip();
      if (!addMenu.hidden) renderMainAddMenu();
      break;
    case "models": {
      availableModels = data.models || [];
      modelParamState = data.savedParams || {};
      selectedModelId = data.selected || "auto";
      const selected = selectedModelDefinition();
      if (selected) paramsForModel(selected);
      updateModelButton();
      renderModelList();
      renderModelOptions();
      break;
    }
    case "modelSelected":
      selectedModelId = data.id || "auto";
      updateModelButton();
      break;
    case "approvalModeSelected":
      setApprovalMode(data.mode);
      break;
    case "executionProfileState":
      executionProfileLabel = typeof data.label === "string" ? data.label : "";
      refreshApprovalSelectTitle();
      break;
    case "sandboxSupport":
      sandboxSupported = data.supported !== false;
      if (!sandboxSupported) sandboxUnavailable = true;
      updateSandboxBanner();
      if (!running) {
        status.textContent = sandboxUnavailable
          ? sandboxStatusForMode(approvalSelect.value)
          : i18n.connected;
      }
      break;
    case "sandboxUnavailable":
      sandboxUnavailable = true;
      status.textContent = sandboxStatusForMode(approvalSelect.value);
      updateSandboxBanner();
      break;
    case "home":
      showHome(data.conversations, data.searchQuery);
      break;
    case "usageStats":
      usageSummary = data.summary || null;
      usageBudget = data.budget || null;
      usageMonthlyBudget = data.monthlyBudget || null;
      usageEstimatedCost = data.estimatedCost || null;
      usageInlineCompletion = data.inlineCompletion || null;
      renderUsagePanel();
      if (view === "home") {
        renderTasks();
      }
      break;
    case "bestOfNExperiments":
      bestOfNExperiments = data.experiments || [];
      if (view === "home") {
        renderExperiments();
      }
      break;
    case "bestOfNCompare":
      view = "home";
      home.style.display = "flex";
      messages.style.display = "none";
      setRunningState(false);
      updateFindChrome();
      renderCompare(data.experiment);
      break;
    case "orchestratorExperiments":
      orchestratorExperiments = data.experiments || [];
      if (view === "home") {
        renderOrchestratorExperiments();
        if (openOrchestratorId) {
          vscode.postMessage({ type: "openOrchestrator", id: openOrchestratorId });
        }
      }
      break;
    case "orchestratorDetail":
      view = "home";
      home.style.display = "flex";
      messages.style.display = "none";
      setRunningState(false);
      updateFindChrome();
      renderOrchestratorDetail(data.experiment);
      break;
    case "orchestratorActivity":
      patchOrchestratorActivity(data);
      patchParallelTaskActivity(data);
      break;
    case "contextPreview":
      renderContextPreview(data.chips || []);
      break;
    case "openFind":
      if (view === "chat") {
        openFindBar();
      }
      break;
    case "newChat":
      setRunningState(false);
      clearMessages();
      showChat();
      prompt.focus();
      break;
    case "chat": {
      clearMessages();
      showChat();
      for (let entryIndex = 0; entryIndex < data.entries.length; entryIndex += 1) {
        const entry = data.entries[entryIndex];
        if (entry.role === "user") {
          const attachments = (entry.attachments || []).map((attachment) => {
            if (typeof attachment === "string") {
              return {
                path: attachment,
                label: attachment.split(/[\\/]/).pop() || attachment,
              };
            }
            return {
              path: attachment.path,
              label: attachment.label || attachment.path.split(/[\\/]/).pop() || attachment.path,
            };
          });
          addUserMessage(entry.text, attachments);
        } else {
          const files = (entry.files || []).map((p) => ({ path: p, label: p.split(/[\\/]/).pop() || p }));
          const live = data.running === true && entryIndex === data.entries.length - 1;
          if (live) {
            assistantRaw = entry.text || "";
            assistantNode = addAssistantMessage(
              assistantRaw,
              entry.error === true,
              files,
              [],
              "completed",
              entry.recoveryActions,
            );
            activeProgress = createProgressPanel(entry.progress || [], "running");
            assistantNode.before(activeProgress.node);
          } else {
            addAssistantMessage(
              entry.text,
              entry.error === true,
              files,
              entry.progress || [],
              entry.progressState || (entry.error === true ? "error" : "completed"),
              entry.recoveryActions,
            );
          }
        }
      }
      setRunningState(data.running === true);
      reapplyFindIfActive();
      break;
    }
    case "queueState":
      queuedMessages = data.items || [];
      renderQueue();
      break;
    case "parallelState":
      activeChatRuns = Number(data.activeRuns) || 0;
      maximumChatRuns = Math.max(1, Number(data.maximumRuns) || 3);
      parallelTasks = Array.isArray(data.tasks) ? data.tasks : [];
      renderParallelBar();
      renderQueue();
      if (running) {
        status.textContent = i18n.running + "…"
          + (activeChatRuns > 1 ? " · " + activeChatRuns + " " + i18n.activeAgents : "");
      }
      break;
    case "queuedStarted": {
      showChat();
      const attachments = (data.files || []).map((file) => ({
        path: file,
        label: file.split(/[\/]/).pop() || file,
      }));
      addUserMessage(data.prompt, attachments);
      assistantRaw = "";
      assistantNode = addAssistantMessage("");
      break;
    }
    case "started":
      setRunningState(true);
      beginProgress();
      break;
    case "toolStatus":
      status.textContent = i18n.running + ": " + data.text;
      updateProgress(data);
      break;
    case "contextAttached": {
      const nodes = messages.querySelectorAll(".user");
      const lastUser = nodes[nodes.length - 1];
      if (lastUser) {
        const note = document.createElement("div");
        note.className = "context-note";
        note.textContent = i18n.attached + ": " + data.label;
        lastUser.appendChild(note);
      }
      break;
    }
    case "chunk":
      if (view !== "chat") break;
      if (!assistantNode) assistantNode = addAssistantMessage("");
      assistantRaw += data.text;
      renderMarkdown(assistantNode, assistantRaw);
      scrollToBottom();
      break;
    case "fileEdited":
      if (view !== "chat") break;
      if (!assistantNode) assistantNode = addAssistantMessage("");
      addFileChip(assistantNode, data.path, data.label);
      break;
    case "error":
      finishProgress("error");
      stopRunningSound();
      playErrorSound();
      if (assistantNode && !assistantRaw) {
        messageBody(assistantNode).textContent = data.text;
        assistantNode.classList.add("error");
        ensureMessageCopy(assistantNode);
        renderRecoveryActions(assistantNode, data.recoveryActions);
      } else {
        addAssistantMessage(data.text, true, [], [], "completed", data.recoveryActions);
      }
      break;
    case "cancelled":
      finishProgress("stopped");
      if (assistantNode && !assistantRaw) {
        messageBody(assistantNode).textContent = i18n.stopped;
        ensureMessageCopy(assistantNode);
      }
      break;
    case "finished":
      finishProgress("completed");
      stopRunningSound();
      playCompletionSound();
      break;
    case "idle":
      setRunningState(false);
      assistantNode = undefined;
      assistantRaw = "";
      activeProgress = undefined;
      // A run can finish while the user is editing or using another view.
      // Only restore the caret when this webview still owns focus.
      if (document.hasFocus()) prompt.focus({ preventScroll: true });
      break;
  }
});

vscode.postMessage({ type: "ready" });
