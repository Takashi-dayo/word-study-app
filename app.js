(() => {
  "use strict";

  const DB_NAME = "word-study-app-db";
  const DB_VERSION = 1;
  const STORE_NAME = "appState";
  const RECORD_KEY = "main";
  const LEGACY_STORAGE_KEYS = ["custom-word-study-app-v1", "custom-word-study-app-v2"];
  const APP_DATA_VERSION = 3;
  const BACKUP_CHANGE_THRESHOLD = 50;
  const BACKUP_DAY_THRESHOLD = 30;
  const BACKUP_SNOOZE_DAYS = 7;

  let database = null;
  let saveQueue = Promise.resolve();
  let deferredInstallPrompt = null;

  const state = {
    words: [],
    meta: createDefaultMeta(),
    currentQuizWordId: null,
    currentDirection: "en-ja",
    answered: false,
    filteredQuizIds: [],
    quizSessionIds: [],
    quizSessionIndex: 0,
    quizSessionComplete: false
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  function createDefaultMeta() {
    const now = new Date().toISOString();
    return {
      firstUsedAt: now,
      lastSavedAt: null,
      lastBackupAt: null,
      changesSinceBackup: 0,
      backupReminderDismissedAt: null,
      storagePersisted: null,
      migratedFromLocalStorage: false
    };
  }

  function normalizeMeta(meta) {
    const defaults = createDefaultMeta();
    return {
      ...defaults,
      ...(meta && typeof meta === "object" ? meta : {}),
      changesSinceBackup: Number.isFinite(meta?.changesSinceBackup)
        ? Math.max(0, meta.changesSinceBackup)
        : 0,
      storagePersisted: typeof meta?.storagePersisted === "boolean"
        ? meta.storagePersisted
        : null
    };
  }

  function generateId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function normalizeWord(word) {
    return {
      id: String(word?.id || generateId()),
      english: String(word?.english || "").trim(),
      japanese: String(word?.japanese || "").trim(),
      correct: Number.isFinite(word?.correct) ? Math.max(0, word.correct) : 0,
      mistakes: Number.isFinite(word?.mistakes) ? Math.max(0, word.mistakes) : 0,
      mistakeHistory: Array.isArray(word?.mistakeHistory)
        ? word.mistakeHistory.filter(Boolean).map(String)
        : [],
      reviewDates: Array.isArray(word?.reviewDates)
        ? [...new Set(word.reviewDates.filter(Boolean).map(String))].sort()
        : [],
      createdAt: Number.isFinite(word?.createdAt) ? word.createdAt : Date.now()
    };
  }

  function normalizeWords(words) {
    return Array.isArray(words)
      ? words.map(normalizeWord).filter((word) => word.english && word.japanese)
      : [];
  }

  function openDatabase() {
    if (database) return Promise.resolve(database);
    if (!("indexedDB" in window)) return Promise.reject(new Error("IndexedDB非対応"));

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
      };
      request.onsuccess = () => {
        database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => reject(request.error || new Error("IndexedDBを開けない"));
      request.onblocked = () => reject(new Error("IndexedDB更新がブロックされた"));
    });
  }

  async function readStateRecord() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(RECORD_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("保存データを読み込めない"));
    });
  }

  async function writeStateRecord(record) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("保存に失敗した"));
      tx.onabort = () => reject(tx.error || new Error("保存処理が中断された"));
    });
  }

  function createRecordSnapshot() {
    return {
      key: RECORD_KEY,
      version: APP_DATA_VERSION,
      words: JSON.parse(JSON.stringify(state.words)),
      meta: JSON.parse(JSON.stringify(state.meta))
    };
  }

  async function migrateLegacyLocalStorage() {
    for (const key of LEGACY_STORAGE_KEYS) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        const words = normalizeWords(parsed?.words);
        if (!words.length && Array.isArray(parsed?.words) && parsed.words.length) continue;
        state.words = words;
        state.meta = {
          ...createDefaultMeta(),
          migratedFromLocalStorage: true,
          changesSinceBackup: words.length ? 1 : 0
        };
        await writeStateRecord(createRecordSnapshot());
        return true;
      } catch (error) {
        console.warn("旧データ移行をスキップ:", error);
      }
    }
    return false;
  }

  async function loadData() {
    try {
      const record = await readStateRecord();
      if (record) {
        state.words = normalizeWords(record.words);
        state.meta = normalizeMeta(record.meta);
        return;
      }

      const migrated = await migrateLegacyLocalStorage();
      if (!migrated) {
        state.words = [];
        state.meta = createDefaultMeta();
        await writeStateRecord(createRecordSnapshot());
      }
    } catch (error) {
      console.error("データの読み込みに失敗:", error);
      state.words = [];
      state.meta = createDefaultMeta();
      showStorageFailure("IndexedDBを利用できない。通常モードのブラウザで開く必要がある。");
    }
  }

  function saveData({ changeAmount = 1 } = {}) {
    if (changeAmount > 0) {
      state.meta.changesSinceBackup += changeAmount;
    }
    state.meta.lastSavedAt = new Date().toISOString();

    refreshAll();
    const snapshot = createRecordSnapshot();
    saveQueue = saveQueue
      .then(() => writeStateRecord(snapshot))
      .catch((error) => {
        console.error("データ保存に失敗:", error);
        showStorageFailure("端末内への保存に失敗した。JSONバックアップを書き出す必要がある。");
      });
    return saveQueue;
  }

  function showStorageFailure(message) {
    const target = $("#storageWarning");
    if (target) {
      target.hidden = false;
      const detail = target.querySelector(".muted");
      if (detail) detail.textContent = message;
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function normalize(value) {
    return String(value)
      .normalize("NFKC")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function normalizeLoose(value) {
    return normalize(value)
      .replace(/[。、，,.!！?？・]/g, "")
      .replace(/\s+/g, "");
  }

  function splitAnswers(value) {
    return String(value)
      .split(/[、,，\/／;；|｜]/)
      .map((part) => part.trim())
      .filter(Boolean);
  }

  function isCorrectAnswer(input, expected, strict) {
    const answers = splitAnswers(expected);
    if (!answers.length) answers.push(expected);

    if (strict) {
      const normalizedInput = normalize(input);
      return answers.some((answer) => normalizedInput === normalize(answer));
    }

    const normalizedInput = normalizeLoose(input);
    return answers.some((answer) => normalizedInput === normalizeLoose(answer));
  }

  function localDateString(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function addDaysToLocalDate(baseDateString, days) {
    const [year, month, day] = baseDateString.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    date.setDate(date.getDate() + days);
    return localDateString(date);
  }

  function scheduleReview(word, baseDate = localDateString()) {
    const offsets = [1, 4, 7, 14, 30];
    const dates = offsets.map((days) => addDaysToLocalDate(baseDate, days));
    word.reviewDates = [...new Set([...(word.reviewDates || []), ...dates])].sort();
    word.mistakeHistory = [...(word.mistakeHistory || []), baseDate];
  }

  function dueDates(word, today = localDateString()) {
    return (word.reviewDates || []).filter((date) => date <= today);
  }

  function isUnanswered(word) {
    return word.correct + word.mistakes === 0;
  }

  function isDueToday(word) {
    return isUnanswered(word) || dueDates(word).length > 0;
  }

  function completeDueReviews(word, today = localDateString()) {
    word.reviewDates = (word.reviewDates || []).filter((date) => date > today);
  }

  function addWord(english, japanese) {
    const en = english.trim();
    const ja = japanese.trim();
    if (!en || !ja) return { ok: false, message: "英語と日本語訳の両方を入力する必要がある。" };

    const duplicate = state.words.find(
      (word) => normalize(word.english) === normalize(en) && normalize(word.japanese) === normalize(ja)
    );
    if (duplicate) return { ok: false, message: "同じ英語・日本語訳の組み合わせが既に登録されている。" };

    state.words.unshift({
      id: generateId(),
      english: en,
      japanese: ja,
      correct: 0,
      mistakes: 0,
      mistakeHistory: [],
      reviewDates: [],
      createdAt: Date.now()
    });

    saveData();
    return { ok: true, message: `「${en}」を追加した。` };
  }

  function showNotice(target, message, type = "") {
    target.innerHTML = `<div class="notice ${type}">${escapeHtml(message)}</div>`;
  }

  function switchTab(tabName) {
    $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === tabName));
    $$(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === `panel-${tabName}`));

    if (tabName === "quiz") prepareQuiz();
    if (tabName === "today") renderToday();
    if (tabName === "mistakes") renderMistakes();
    if (tabName === "list") renderWordList();
    if (tabName === "data") renderStorageStatus();
  }

  function updateSummary() {
    const totalAnswers = state.words.reduce((sum, word) => sum + word.correct + word.mistakes, 0);
    const totalCorrect = state.words.reduce((sum, word) => sum + word.correct, 0);
    const todayCount = state.words.filter(isDueToday).length;
    $("#statWords").textContent = state.words.length;
    $("#statAnswers").textContent = totalAnswers;
    $("#statCorrect").textContent = totalCorrect;
    $("#statRate").textContent = totalAnswers ? `${Math.round((totalCorrect / totalAnswers) * 100)}%` : "—";
    $("#statToday").textContent = todayCount;
  }

  function getAccuracy(word) {
    const total = word.correct + word.mistakes;
    return total ? Math.round((word.correct / total) * 100) : null;
  }

  function tableMarkup(words, mode = "list") {
    if (!words.length) {
      return `<div class="empty">${mode === "mistakes" ? "間違い記録はまだない。" : "条件に一致する単語はない。"}</div>`;
    }

    const rows = words.map((word) => {
      const accuracy = getAccuracy(word);
      const actions = mode === "mistakes"
        ? `<button class="btn small ghost" data-action="reset" data-id="${escapeHtml(word.id)}">回数をリセット</button>`
        : `
          <button class="btn small ghost" data-action="edit" data-id="${escapeHtml(word.id)}">編集</button>
          <button class="btn small danger" data-action="delete" data-id="${escapeHtml(word.id)}">削除</button>
        `;

      return `
        <tr>
          <td><strong>${escapeHtml(word.english)}</strong></td>
          <td>${escapeHtml(word.japanese)}</td>
          <td class="number">${word.correct}</td>
          <td class="number mistake-count">${word.mistakes}</td>
          <td class="number rate">${accuracy === null ? "—" : `${accuracy}%`}</td>
          <td><div class="button-row" style="margin:0">${actions}</div></td>
        </tr>
      `;
    }).join("");

    return `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>英語</th>
              <th>日本語訳</th>
              <th class="number">正解</th>
              <th class="number">誤答</th>
              <th class="number">正答率</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function sortedWords(words, sort) {
    const copy = [...words];
    switch (sort) {
      case "oldest": return copy.sort((a, b) => a.createdAt - b.createdAt);
      case "english": return copy.sort((a, b) => a.english.localeCompare(b.english, "en"));
      case "mistakes-desc": return copy.sort((a, b) => b.mistakes - a.mistakes || b.createdAt - a.createdAt);
      case "newest":
      default: return copy.sort((a, b) => b.createdAt - a.createdAt);
    }
  }

  function renderWordList() {
    const query = normalize($("#searchInput").value);
    const filtered = state.words.filter((word) =>
      !query || normalize(word.english).includes(query) || normalize(word.japanese).includes(query)
    );
    $("#wordTable").innerHTML = tableMarkup(sortedWords(filtered, $("#listSort").value));
  }

  function renderMistakes() {
    const words = state.words
      .filter((word) => word.mistakes > 0)
      .sort((a, b) => b.mistakes - a.mistakes || a.english.localeCompare(b.english, "en"));
    $("#mistakeTable").innerHTML = tableMarkup(words, "mistakes");
  }

  function renderToday() {
    const today = localDateString();
    const words = state.words
      .filter(isDueToday)
      .sort((a, b) => {
        const aUnanswered = isUnanswered(a);
        const bUnanswered = isUnanswered(b);
        if (aUnanswered !== bUnanswered) return aUnanswered ? -1 : 1;
        if (aUnanswered && bUnanswered) return a.createdAt - b.createdAt;
        const aDate = dueDates(a, today).sort()[0] || "9999-12-31";
        const bDate = dueDates(b, today).sort()[0] || "9999-12-31";
        return aDate.localeCompare(bDate) || b.mistakes - a.mistakes;
      });

    const unansweredCount = words.filter(isUnanswered).length;
    const reviewCount = words.length - unansweredCount;
    $("#todayCount").textContent = words.length;
    $("#todayMessage").textContent = words.length
      ? `未回答${unansweredCount}語・復習期限到達${reviewCount}語、合計${words.length}語が対象だ。`
      : "今日の学習対象はない。";
    $("#startTodayBtn").disabled = words.length === 0;

    if (!words.length) {
      $("#todayTable").innerHTML = '<div class="empty">未回答の単語と、復習期限に到達した単語はここに表示される。</div>';
      return;
    }

    const rows = words.map((word) => {
      const unanswered = isUnanswered(word);
      const oldestDue = dueDates(word, today).sort()[0];
      const status = unanswered ? "未回答" : `${oldestDue}から期限`;
      return `
        <tr>
          <td><strong>${escapeHtml(word.english)}</strong></td>
          <td>${escapeHtml(word.japanese)}</td>
          <td><span class="due-badge">${escapeHtml(status)}</span></td>
          <td class="number mistake-count">${word.mistakes}</td>
        </tr>`;
    }).join("");

    $("#todayTable").innerHTML = `
      <div class="table-wrap">
        <table>
          <thead><tr><th>英語</th><th>日本語訳</th><th>区分</th><th class="number">誤答</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function getFilteredQuizWords(range = $("#quizRange").value) {
    let words = [...state.words];
    if (range === "mistakes") words = words.filter((word) => word.mistakes > 0);
    if (range === "today") words = words.filter(isDueToday);
    if (range === "unanswered") words = words.filter(isUnanswered);
    return words;
  }

  function usesQuestionLimit(range = $("#quizRange").value) {
    return range === "all" || range === "mistakes";
  }

  function updateQuizCountControl() {
    const range = $("#quizRange").value;
    const group = $("#quizCountGroup");
    const input = $("#quizCount");
    const hint = $("#quizCountHint");
    const limited = usesQuestionLimit(range);

    group.hidden = !limited;
    if (!limited) return;

    const available = getFilteredQuizWords(range).length;
    input.disabled = available === 0;
    input.max = String(Math.max(1, available));

    let requested = Number.parseInt(input.value, 10);
    if (!Number.isFinite(requested) || requested < 1) requested = Math.min(10, Math.max(1, available));
    if (available > 0) requested = Math.min(requested, available);
    input.value = String(requested);

    hint.textContent = available > 0
      ? `1〜${available}問から指定`
      : "出題できる単語がない";
  }

  function requestedQuestionCount(available) {
    if (!usesQuestionLimit()) return available;
    const input = $("#quizCount");
    const parsed = Number.parseInt(input.value, 10);
    const fallback = Math.min(10, available);
    const count = Number.isFinite(parsed) ? parsed : fallback;
    return Math.max(1, Math.min(count, available));
  }

  function getQuizPool() {
    const range = $("#quizRange").value;
    let words = getFilteredQuizWords(range);

    const order = $("#quizOrder").value;
    if (order === "mistakes-desc") {
      words.sort((a, b) => b.mistakes - a.mistakes || b.createdAt - a.createdAt);
    } else if (order === "newest") {
      words.sort((a, b) => b.createdAt - a.createdAt);
    } else {
      for (let i = words.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [words[i], words[j]] = [words[j], words[i]];
      }
    }

    if (usesQuestionLimit(range) && words.length) {
      words = words.slice(0, requestedQuestionCount(words.length));
    }
    return words;
  }

  function resetQuizSession() {
    state.currentQuizWordId = null;
    state.filteredQuizIds = [];
    state.quizSessionIds = [];
    state.quizSessionIndex = 0;
    state.quizSessionComplete = false;
    state.answered = false;
  }

  function showQuizEmpty(message, action = "add") {
    $("#quizEmpty").hidden = false;
    $("#quizContent").hidden = true;
    $("#quizEmpty .empty").textContent = message;
    const button = $("#quizEmptyAction");
    button.dataset.action = action;
    button.textContent = action === "restart" ? "同じ条件でもう一度" : "単語を登録する";
  }

  function startQuizSession() {
    updateQuizCountControl();
    const pool = getQuizPool();
    state.filteredQuizIds = pool.map((word) => word.id);
    state.quizSessionIds = [...state.filteredQuizIds];
    state.quizSessionIndex = 0;
    state.quizSessionComplete = false;
    state.currentQuizWordId = null;

    if (!pool.length) {
      showQuizEmpty(
        state.words.length
          ? "選択した出題範囲に該当する単語がない。"
          : "単語を登録すると問題を開始できる。",
        "add"
      );
      return;
    }

    $("#quizEmpty").hidden = true;
    $("#quizContent").hidden = false;
    chooseNextQuestion(true);
  }

  function prepareQuiz(forceNew = false) {
    updateQuizCountControl();

    if (forceNew || !state.quizSessionIds.length) {
      startQuizSession();
      return;
    }

    if (state.quizSessionComplete) {
      showQuizEmpty(`${state.quizSessionIds.length}問が終了した。`, "restart");
      return;
    }

    const currentExists = state.words.some((word) => word.id === state.currentQuizWordId);
    if (!currentExists) {
      chooseNextQuestion(false);
      return;
    }

    $("#quizEmpty").hidden = true;
    $("#quizContent").hidden = false;
    renderCurrentQuestion();
  }

  function completeQuizSession() {
    state.currentQuizWordId = null;
    state.quizSessionComplete = true;
    state.answered = false;
    showQuizEmpty(`${state.quizSessionIds.length}問が終了した。`, "restart");
  }

  function findNextExistingSessionWord(startIndex) {
    for (let index = startIndex; index < state.quizSessionIds.length; index++) {
      const word = state.words.find((item) => item.id === state.quizSessionIds[index]);
      if (word) return { word, index };
    }
    return null;
  }

  function hasNextSessionWord() {
    return Boolean(findNextExistingSessionWord(state.quizSessionIndex + 1));
  }

  function chooseNextQuestion(first = false) {
    if (!state.quizSessionIds.length) {
      startQuizSession();
      return;
    }

    const startIndex = first ? 0 : state.quizSessionIndex + 1;
    const next = findNextExistingSessionWord(startIndex);
    if (!next) {
      completeQuizSession();
      return;
    }

    state.quizSessionIndex = next.index;
    state.currentQuizWordId = next.word.id;
    const directionSetting = $("#quizDirection").value;
    state.currentDirection = directionSetting === "random"
      ? (Math.random() < 0.5 ? "en-ja" : "ja-en")
      : directionSetting;
    state.answered = false;
    renderCurrentQuestion();
  }

  function renderCurrentQuestion() {
    const word = state.words.find((item) => item.id === state.currentQuizWordId);
    if (!word) {
      chooseNextQuestion(false);
      return;
    }

    const enToJa = state.currentDirection === "en-ja";
    $("#quizProgress").textContent = `${state.quizSessionIndex + 1} / ${state.quizSessionIds.length}`;
    $("#questionLabel").textContent = enToJa ? "日本語訳を入力" : "英語を入力";
    $("#questionText").textContent = enToJa ? word.english : word.japanese;
    $("#answerInput").value = "";
    $("#answerInput").disabled = false;
    $("#checkBtn").hidden = false;
    $("#showAnswerBtn").hidden = false;
    $("#skipBtn").hidden = false;
    $("#nextBtn").hidden = true;
    $("#nextBtn").textContent = "次の問題";
    $("#feedback").className = "feedback";
    $("#feedback").textContent = "回答を入力して「答え合わせ」を押す。";
    state.answered = false;
    setTimeout(() => $("#answerInput").focus(), 0);
  }

  function finishAnswer(result, message) {
    state.answered = true;
    $("#answerInput").disabled = true;
    $("#checkBtn").hidden = true;
    $("#showAnswerBtn").hidden = true;
    $("#skipBtn").hidden = true;
    $("#nextBtn").hidden = false;
    $("#nextBtn").textContent = hasNextSessionWord() ? "次の問題" : "終了";
    $("#feedback").className = `feedback ${result}`;
    $("#feedback").innerHTML = message;
    $("#nextBtn").focus();
  }

  function checkAnswer() {
    if (state.answered) return chooseNextQuestion();
    const word = state.words.find((item) => item.id === state.currentQuizWordId);
    if (!word) return;

    const input = $("#answerInput").value.trim();
    if (!input) {
      $("#feedback").className = "feedback wrong";
      $("#feedback").textContent = "回答が未入力だ。";
      return;
    }

    const expected = state.currentDirection === "en-ja" ? word.japanese : word.english;
    const correct = isCorrectAnswer(input, expected, $("#strictAnswer").checked);
    if (correct) {
      word.correct += 1;
      if ($("#quizRange").value === "today") completeDueReviews(word);
      saveData();
      finishAnswer("correct", `<strong>正解。</strong><br>答え: ${escapeHtml(expected)}`);
    } else {
      word.mistakes += 1;
      if ($("#quizRange").value === "today") completeDueReviews(word);
      scheduleReview(word);
      saveData();
      finishAnswer("wrong", `<strong>不正解。</strong><br>正しい答え: ${escapeHtml(expected)}`);
    }
  }

  function revealAnswer() {
    if (state.answered) return;
    const word = state.words.find((item) => item.id === state.currentQuizWordId);
    if (!word) return;
    const expected = state.currentDirection === "en-ja" ? word.japanese : word.english;
    word.mistakes += 1;
    if ($("#quizRange").value === "today") completeDueReviews(word);
    scheduleReview(word);
    saveData();
    finishAnswer("wrong", `<strong>答えを表示したため誤答として記録。</strong><br>答え: ${escapeHtml(expected)}`);
  }

  function skipQuestion() {
    if (!state.answered) chooseNextQuestion();
  }

  function refreshAll() {
    updateSummary();
    renderWordList();
    renderMistakes();
    renderToday();
    renderStorageStatus();
    updateBackupReminder();
  }

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJson() {
    const now = new Date();
    state.meta.lastBackupAt = now.toISOString();
    state.meta.changesSinceBackup = 0;
    state.meta.backupReminderDismissedAt = null;
    const payload = {
      version: APP_DATA_VERSION,
      exportedAt: now.toISOString(),
      words: state.words,
      meta: state.meta
    };
    downloadFile(
      `word-study-backup-${localDateString(now)}.json`,
      JSON.stringify(payload, null, 2),
      "application/json"
    );
    saveData({ changeAmount: 0 });
    if ($("#dataNotice")) showNotice($("#dataNotice"), "JSONバックアップを書き出した。", "success");
  }

  function csvEscape(value) {
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  function exportCsv() {
    const header = ["english", "japanese", "correct", "mistakes", "mistakeHistory", "reviewDates", "createdAt"];
    const rows = state.words.map((word) => [
      word.english, word.japanese, word.correct, word.mistakes,
      (word.mistakeHistory || []).join("|"),
      (word.reviewDates || []).join("|"),
      new Date(word.createdAt).toISOString()
    ]);
    const csv = "\uFEFF" + [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
    downloadFile(`word-list-${localDateString()}.csv`, csv, "text/csv;charset=utf-8");
  }

  async function importJson(file) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed.words)) throw new Error("words配列がない");
      const imported = normalizeWords(parsed.words);
      if (!imported.length && parsed.words.length) throw new Error("有効な単語がない");
      if (!confirm(`バックアップ内の${imported.length}語で現在のデータを上書きするか？`)) return;

      state.words = imported;
      state.currentQuizWordId = null;
      state.meta = {
        ...normalizeMeta(parsed.meta),
        firstUsedAt: state.meta.firstUsedAt || new Date().toISOString(),
        lastBackupAt: new Date().toISOString(),
        changesSinceBackup: 0,
        backupReminderDismissedAt: null,
        storagePersisted: state.meta.storagePersisted
      };
      await saveData({ changeAmount: 0 });
      showNotice($("#dataNotice"), `${imported.length}語を読み込んだ。`, "success");
    } catch (error) {
      console.error(error);
      showNotice($("#dataNotice"), "読み込みに失敗した。正しいバックアップJSONか確認する必要がある。", "error");
    } finally {
      $("#importInput").value = "";
    }
  }

  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
      script.crossOrigin = "anonymous";
      script.onload = () => resolve(window.Tesseract);
      script.onerror = () => reject(new Error("OCRライブラリを読み込めない"));
      document.head.appendChild(script);
    });
  }

  function formatOcrLines(text) {
    return String(text)
      .split(/\r?\n/)
      .map((rawLine) => rawLine.trim())
      .filter(Boolean)
      .map((line) => {
        if (/\t|[,，]/.test(line)) return line;
        const japaneseIndex = line.search(/[ぁ-んァ-ヶ一-龯々ー]/);
        if (japaneseIndex > 0) {
          const english = line.slice(0, japaneseIndex).trim().replace(/\s{2,}/g, " ");
          const japanese = line.slice(japaneseIndex).trim();
          return `${english}\t${japanese}`;
        }
        const spaced = line.split(/\s{2,}/).filter(Boolean);
        if (spaced.length >= 2) return `${spaced[0]}\t${spaced.slice(1).join(" ")}`;
        return line;
      })
      .join("\n");
  }

  async function runOcr() {
    const file = $("#ocrImageInput").files?.[0];
    if (!file) {
      showNotice($("#ocrNotice"), "先に画像を選択する必要がある。", "error");
      return;
    }

    $("#ocrRunBtn").disabled = true;
    $("#ocrProgress").hidden = false;
    $("#ocrProgress").value = 0;
    showNotice($("#ocrNotice"), "OCRエンジンを準備している。初回はインターネット接続が必要だが、画像は端末内で処理する。");

    try {
      const Tesseract = await loadTesseract();
      const result = await Tesseract.recognize(file, $("#ocrLanguage").value, {
        logger: (message) => {
          if (typeof message.progress === "number") $("#ocrProgress").value = message.progress;
          if (message.status) {
            const percent = typeof message.progress === "number" ? ` ${Math.round(message.progress * 100)}%` : "";
            showNotice($("#ocrNotice"), `処理中: ${message.status}${percent}`);
          }
        }
      });
      const formatted = formatOcrLines(result?.data?.text || "");
      if (!formatted.trim()) throw new Error("文字を検出できない");
      $("#bulkInput").value = formatted;
      showNotice($("#ocrNotice"), "読み取り結果を一括登録欄へ入れた。誤認識を修正してから登録する必要がある。", "success");
      $("#bulkInput").scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (error) {
      console.error(error);
      showNotice($("#ocrNotice"), "OCRに失敗した。通信状態、画像の明るさ、文字の大きさを確認する必要がある。", "error");
    } finally {
      $("#ocrRunBtn").disabled = false;
      $("#ocrProgress").hidden = true;
    }
  }

  function parseBulkLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    if (trimmed.includes("\t")) {
      const [english, ...rest] = trimmed.split("\t");
      return [english, rest.join("\t")];
    }
    const commaIndex = trimmed.search(/[,，]/);
    if (commaIndex >= 0) return [trimmed.slice(0, commaIndex), trimmed.slice(commaIndex + 1)];
    return null;
  }

  function formatDateTime(value) {
    if (!value) return "未実施";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "未実施";
    return new Intl.DateTimeFormat("ja-JP", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    }).format(date);
  }

  function daysSince(value) {
    if (!value) return Infinity;
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) return Infinity;
    return Math.floor((Date.now() - time) / 86400000);
  }

  function updateBackupReminder() {
    const banner = $("#backupBanner");
    if (!banner || !state.words.length) {
      if (banner) banner.hidden = true;
      return;
    }

    const referenceDate = state.meta.lastBackupAt || state.meta.firstUsedAt;
    const age = daysSince(referenceDate);
    const dueByDays = age >= BACKUP_DAY_THRESHOLD;
    const dueByChanges = state.meta.changesSinceBackup >= BACKUP_CHANGE_THRESHOLD;
    const snoozed = state.meta.backupReminderDismissedAt && daysSince(state.meta.backupReminderDismissedAt) < BACKUP_SNOOZE_DAYS;
    const due = (dueByDays || dueByChanges) && !snoozed;
    banner.hidden = !due;
    if (!due) return;

    const reasons = [];
    if (dueByDays) reasons.push(`前回のバックアップ基準から${age}日経過`);
    if (dueByChanges) reasons.push(`${state.meta.changesSinceBackup}件の変更`);
    $("#backupBannerText").textContent = `${reasons.join("・")}している。端末内へJSONを保存する。`;
  }

  async function renderStorageStatus() {
    if (!$("#databaseStatus")) return;
    $("#databaseStatus").textContent = database ? "IndexedDBへ自動保存中" : "IndexedDBを利用できない";
    $("#databaseDetail").textContent = `${state.words.length}語・最終保存 ${formatDateTime(state.meta.lastSavedAt)}`;

    if (state.meta.storagePersisted === true) {
      $("#persistenceStatus").textContent = "有効";
      $("#persistenceDetail").textContent = "ブラウザによる自動削除を抑制";
    } else if (state.meta.storagePersisted === false) {
      $("#persistenceStatus").textContent = "未許可";
      $("#persistenceDetail").textContent = "JSONバックアップを推奨";
    } else {
      $("#persistenceStatus").textContent = "非対応または未確認";
      $("#persistenceDetail").textContent = "通常のIndexedDB保存は継続";
    }

    $("#lastBackupStatus").textContent = formatDateTime(state.meta.lastBackupAt);
    $("#backupChangeStatus").textContent = `バックアップ後の変更: ${state.meta.changesSinceBackup}件`;

    try {
      if (navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate();
        const usage = estimate.usage || 0;
        $("#storageUsageStatus").textContent = usage < 1024 * 1024
          ? `${Math.max(1, Math.round(usage / 1024))} KB`
          : `${(usage / 1024 / 1024).toFixed(1)} MB`;
      } else {
        $("#storageUsageStatus").textContent = "取得不可";
      }
    } catch {
      $("#storageUsageStatus").textContent = "取得不可";
    }
  }

  async function requestPersistentStorage(showResult = false) {
    const warning = $("#storageWarning");
    if (!navigator.storage?.persisted || !navigator.storage?.persist) {
      state.meta.storagePersisted = null;
      if (warning) warning.hidden = false;
      renderStorageStatus();
      return false;
    }

    try {
      let persisted = await navigator.storage.persisted();
      if (!persisted) persisted = await navigator.storage.persist();
      state.meta.storagePersisted = persisted;
      if (warning) warning.hidden = persisted;
      await saveData({ changeAmount: 0 });
      if (showResult && $("#dataNotice")) {
        showNotice(
          $("#dataNotice"),
          persisted ? "保存保護が有効になった。" : "ブラウザが保存保護を許可しなかった。JSONバックアップを併用する必要がある。",
          persisted ? "success" : "error"
        );
      }
      return persisted;
    } catch (error) {
      console.warn("永続ストレージ要求に失敗:", error);
      state.meta.storagePersisted = false;
      if (warning) warning.hidden = false;
      renderStorageStatus();
      return false;
    }
  }

  function setupPwaInstall() {
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      deferredInstallPrompt = event;
      $("#installBtn").hidden = false;
    });
    window.addEventListener("appinstalled", () => {
      deferredInstallPrompt = null;
      $("#installBtn").hidden = true;
    });
  }

  async function installPwa() {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $("#installBtn").hidden = true;
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
    navigator.serviceWorker.register("./service-worker.js").catch((error) => {
      console.warn("Service Worker登録失敗:", error);
    });
  }

  function bindEvents() {
    $$(".tab").forEach((tab) => tab.addEventListener("click", () => switchTab(tab.dataset.tab)));
    $$('[data-open-tab]').forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.openTab)));

    $("#addForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const result = addWord($("#englishInput").value, $("#japaneseInput").value);
      showNotice($("#addNotice"), result.message, result.ok ? "success" : "error");
      if (result.ok) {
        $("#englishInput").value = "";
        $("#japaneseInput").value = "";
        $("#englishInput").focus();
      }
    });

    $("#addAndContinueBtn").addEventListener("click", () => {
      const result = addWord($("#englishInput").value, $("#japaneseInput").value);
      showNotice($("#addNotice"), result.message, result.ok ? "success" : "error");
      if (result.ok) {
        $("#englishInput").value = "";
        $("#japaneseInput").value = "";
      }
      $("#englishInput").focus();
    });

    $("#bulkAddBtn").addEventListener("click", () => {
      const lines = $("#bulkInput").value.split(/\r?\n/);
      let added = 0;
      let skipped = 0;
      for (const line of lines) {
        const parsed = parseBulkLine(line);
        if (!parsed) {
          if (line.trim()) skipped++;
          continue;
        }
        const result = addWord(parsed[0], parsed[1]);
        result.ok ? added++ : skipped++;
      }
      showNotice($("#bulkNotice"), `${added}語を追加、${skipped}行をスキップした。`, added ? "success" : "error");
      if (added) $("#bulkInput").value = "";
    });

    $("#ocrImageInput").addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      const preview = $("#ocrPreview");
      if (!file) {
        preview.textContent = "画像を選択するとここに表示する。";
        return;
      }
      const url = URL.createObjectURL(file);
      preview.innerHTML = `<img src="${url}" alt="OCR対象画像のプレビュー">`;
      preview.querySelector("img").addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
    });
    $("#ocrRunBtn").addEventListener("click", runOcr);

    $("#startTodayBtn").addEventListener("click", () => {
      $("#quizRange").value = "today";
      resetQuizSession();
      switchTab("quiz");
      prepareQuiz(true);
    });

    $("#quizEmptyAction").addEventListener("click", () => {
      if ($("#quizEmptyAction").dataset.action === "restart") {
        resetQuizSession();
        prepareQuiz(true);
      } else {
        switchTab("add");
      }
    });

    $("#quizDirection").addEventListener("change", () => {
      resetQuizSession();
      prepareQuiz(true);
    });
    $("#quizRange").addEventListener("change", () => {
      resetQuizSession();
      updateQuizCountControl();
      prepareQuiz(true);
    });
    $("#quizOrder").addEventListener("change", () => {
      resetQuizSession();
      prepareQuiz(true);
    });
    $("#quizCount").addEventListener("change", () => {
      updateQuizCountControl();
      resetQuizSession();
      prepareQuiz(true);
    });
    $("#checkBtn").addEventListener("click", checkAnswer);
    $("#showAnswerBtn").addEventListener("click", revealAnswer);
    $("#skipBtn").addEventListener("click", skipQuestion);
    $("#nextBtn").addEventListener("click", () => chooseNextQuestion());
    $("#answerInput").addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      state.answered ? chooseNextQuestion() : checkAnswer();
    });

    $("#searchInput").addEventListener("input", renderWordList);
    $("#listSort").addEventListener("change", renderWordList);

    $("#wordTable").addEventListener("click", (event) => {
      const button = event.target.closest("[data-action]");
      if (!button) return;
      const word = state.words.find((item) => item.id === button.dataset.id);
      if (!word) return;

      if (button.dataset.action === "delete") {
        if (!confirm(`「${word.english}」を削除するか？`)) return;
        state.words = state.words.filter((item) => item.id !== word.id);
        resetQuizSession();
        saveData();
      }
      if (button.dataset.action === "edit") {
        $("#editId").value = word.id;
        $("#editEnglish").value = word.english;
        $("#editJapanese").value = word.japanese;
        $("#editDialog").showModal();
        $("#editEnglish").focus();
      }
    });

    $("#mistakeTable").addEventListener("click", (event) => {
      const button = event.target.closest('[data-action="reset"]');
      if (!button) return;
      const word = state.words.find((item) => item.id === button.dataset.id);
      if (!word) return;
      word.correct = 0;
      word.mistakes = 0;
      word.mistakeHistory = [];
      word.reviewDates = [];
      saveData();
    });

    $("#editForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const word = state.words.find((item) => item.id === $("#editId").value);
      if (!word) return;
      const english = $("#editEnglish").value.trim();
      const japanese = $("#editJapanese").value.trim();
      if (!english || !japanese) return;
      word.english = english;
      word.japanese = japanese;
      saveData();
      $("#editDialog").close();
    });
    $("#cancelEditBtn").addEventListener("click", () => $("#editDialog").close());

    $("#exportBtn").addEventListener("click", exportJson);
    $("#exportBtn2").addEventListener("click", exportJson);
    $("#backupNowBtn").addEventListener("click", exportJson);
    $("#dismissBackupBtn").addEventListener("click", () => {
      state.meta.backupReminderDismissedAt = new Date().toISOString();
      saveData({ changeAmount: 0 });
    });
    $("#exportCsvBtn").addEventListener("click", exportCsv);
    $("#importInput").addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      if (file) importJson(file);
    });

    const retryPersist = () => requestPersistentStorage(true);
    $("#retryPersistBtn").addEventListener("click", retryPersist);
    $("#retryPersistBtn2").addEventListener("click", retryPersist);
    $("#installBtn").addEventListener("click", installPwa);

    $("#clearAllBtn").addEventListener("click", () => {
      if (!state.words.length) {
        showNotice($("#dataNotice"), "削除するデータがない。");
        return;
      }
      if (!confirm("登録単語と全学習記録を削除する。この操作は元に戻せない。")) return;
      state.words = [];
      resetQuizSession();
      saveData();
      showNotice($("#dataNotice"), "全データを削除した。", "success");
    });
  }

  async function initialize() {
    setupPwaInstall();
    bindEvents();
    registerServiceWorker();
    await loadData();
    refreshAll();
    prepareQuiz(true);
    await requestPersistentStorage(false);
    refreshAll();

    if (state.meta.migratedFromLocalStorage) {
      showNotice($("#dataNotice"), "旧版のlocalStorageデータをIndexedDBへ自動移行した。", "success");
      state.meta.migratedFromLocalStorage = false;
      saveData({ changeAmount: 0 });
    }
  }

  initialize();
})();
