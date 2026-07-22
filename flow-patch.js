(() => {
  "use strict";


  const ready = (callback) => {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
    } else {
      callback();
    }
  };


  ready(() => {
    const quizTab = document.querySelector('.tab[data-tab="quiz"]');
    const todayTab = document.querySelector('.tab[data-tab="today"]');
    const quizPanel = document.getElementById("panel-quiz");
    const quizToolbar = quizPanel?.querySelector(".quiz-toolbar");
    const quizDirection = document.getElementById("quizDirection");
    const quizRange = document.getElementById("quizRange");
    const quizOrder = document.getElementById("quizOrder");
    const quizCount = document.getElementById("quizCount");
    const quizCountGroup = document.getElementById("quizCountGroup");
    const openTodayBtn = document.getElementById("openTodayBtn");
    const startTodayBtn = document.getElementById("startTodayBtn");
    const feedback = document.getElementById("feedback");
    const skipBtn = document.getElementById("skipBtn");
    const nextBtn = document.getElementById("nextBtn");
    const quizEmptyAction = document.getElementById("quizEmptyAction");


    if (!quizTab || !quizPanel || !quizDirection || !quizRange || !quizOrder) return;


    const style = document.createElement("style");
    style.textContent = `
      #skipBtn { display: none !important; }
      #feedback.flow-idle-feedback { display: none !important; }


      .flow-setup-dialog {
        width: min(560px, calc(100% - 24px));
        border: 0;
        padding: 0;
        background: transparent;
        color: var(--text);
      }
      .flow-setup-dialog::backdrop {
        background: rgba(0, 0, 0, .34);
        backdrop-filter: blur(7px);
        -webkit-backdrop-filter: blur(7px);
      }
      .flow-setup-sheet {
        background: var(--surface-solid);
        border: 1px solid var(--line);
        border-radius: 28px;
        padding: 22px;
        box-shadow: var(--shadow-strong);
      }
      .flow-setup-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 18px;
      }
      .flow-setup-head h2 { margin: 0; }
      .flow-setup-close {
        width: 36px;
        height: 36px;
        border: 0;
        border-radius: 50%;
        background: var(--surface-soft);
        color: var(--muted);
        font-size: 1.25rem;
        line-height: 1;
      }
      .flow-setup-grid { display: grid; gap: 14px; }
      .flow-setup-actions {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 10px;
        margin-top: 20px;
      }
      .flow-setup-start { min-height: 50px; font-size: 1rem; }
      .flow-setup-cancel { min-height: 50px; }


      #quizExitBtn {
        display: none;
        position: fixed;
        z-index: 120;
        top: max(12px, env(safe-area-inset-top));
        left: 12px;
        width: 42px;
        height: 42px;
        border: 1px solid var(--line);
        border-radius: 50%;
        background: var(--surface);
        color: var(--text);
        box-shadow: var(--shadow);
        backdrop-filter: blur(22px) saturate(150%);
        -webkit-backdrop-filter: blur(22px) saturate(150%);
        font-size: 1.45rem;
        line-height: 1;
      }


      body.quiz-only-mode {
        min-height: 100dvh;
        background: var(--bg);
      }
      body.quiz-only-mode .topbar,
      body.quiz-only-mode .bottom-dock,
      body.quiz-only-mode .backup-banner,
      body.quiz-only-mode .bottom-backup,
      body.quiz-only-mode #storageWarning {
        display: none !important;
      }
      body.quiz-only-mode .app {
        width: min(760px, calc(100% - 20px));
        min-height: 100dvh;
        padding: max(66px, calc(env(safe-area-inset-top) + 58px)) 0 max(18px, env(safe-area-inset-bottom));
      }
      body.quiz-only-mode .panel { display: none !important; }
      body.quiz-only-mode #panel-quiz { display: block !important; animation: none; }
      body.quiz-only-mode #panel-quiz > h2,
      body.quiz-only-mode #panel-quiz > .quiz-toolbar { display: none !important; }
      body.quiz-only-mode #quizExitBtn { display: grid; place-items: center; }
      body.quiz-only-mode .quiz-card {
        min-height: calc(100dvh - max(92px, calc(env(safe-area-inset-top) + 82px)) - max(18px, env(safe-area-inset-bottom)));
        border: 0;
        border-radius: 28px;
        box-shadow: none;
        background: transparent;
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
        padding-inline: clamp(10px, 4vw, 34px);
      }
      body.quiz-only-mode .quiz-answer { margin-top: 22px; }
      body.quiz-only-mode .feedback { margin-top: 18px; }


      @media (max-width: 560px) {
        .flow-setup-sheet { padding: 19px; border-radius: 24px; }
        .flow-setup-actions { grid-template-columns: 1fr; }
        .flow-setup-cancel { order: 2; }
        body.quiz-only-mode .app { width: calc(100% - 16px); }
        body.quiz-only-mode .quiz-card { padding-inline: 4px; }
      }
    `;
    document.head.appendChild(style);


    const setupDialog = document.createElement("dialog");
    setupDialog.id = "flowSetupDialog";
    setupDialog.className = "flow-setup-dialog";
    setupDialog.innerHTML = `
      <div class="flow-setup-sheet">
        <div class="flow-setup-head">
          <h2 id="flowSetupTitle">問題設定</h2>
          <button class="flow-setup-close" id="flowSetupClose" type="button" aria-label="閉じる">×</button>
        </div>
        <div class="flow-setup-grid">
          <div>
            <label for="flowDirection">出題方向</label>
            <select id="flowDirection">
              <option value="en-ja">英語 → 日本語</option>
              <option value="ja-en">日本語 → 英語</option>
              <option value="random">ランダム</option>
            </select>
          </div>
          <div id="flowRangeGroup">
            <label for="flowRange">出題範囲</label>
            <select id="flowRange">
              <option value="all">すべての単語</option>
              <option value="mistakes">間違えた単語のみ</option>
              <option value="unanswered">未回答の単語のみ</option>
            </select>
          </div>
          <div id="flowOrderGroup">
            <label for="flowOrder">出題順</label>
            <select id="flowOrder">
              <option value="random">ランダム</option>
              <option value="mistakes-desc">誤答回数が多い順</option>
              <option value="newest">新しい順</option>
            </select>
          </div>
          <div id="flowCountGroup">
            <label for="flowCount">問題数</label>
            <input id="flowCount" type="number" min="1" value="10" inputmode="numeric" />
          </div>
        </div>
        <div class="flow-setup-actions">
          <button class="btn primary flow-setup-start" id="flowSetupStart" type="button">問題を開始</button>
          <button class="btn ghost flow-setup-cancel" id="flowSetupCancel" type="button">キャンセル</button>
        </div>
      </div>
    `;
    document.body.appendChild(setupDialog);


    const exitButton = document.createElement("button");
    exitButton.id = "quizExitBtn";
    exitButton.type = "button";
    exitButton.setAttribute("aria-label", "問題を終了");
    exitButton.textContent = "×";
    document.body.appendChild(exitButton);


    const flowDirection = document.getElementById("flowDirection");
    const flowRange = document.getElementById("flowRange");
    const flowOrder = document.getElementById("flowOrder");
    const flowCount = document.getElementById("flowCount");
    const flowRangeGroup = document.getElementById("flowRangeGroup");
    const flowOrderGroup = document.getElementById("flowOrderGroup");
    const flowCountGroup = document.getElementById("flowCountGroup");
    const flowSetupTitle = document.getElementById("flowSetupTitle");
    const flowSetupStart = document.getElementById("flowSetupStart");


    let setupMode = "quiz";
    let allowQuizTab = false;
    let allowTodayStart = false;
    let returnTabName = "today";


    const dispatchChange = (element) => {
      element?.dispatchEvent(new Event("change", { bubbles: true }));
    };


    const updateCountVisibility = () => {
      if (!flowCountGroup || setupMode === "today") return;
      flowCountGroup.hidden = flowRange.value === "unanswered";
    };


    const openSetup = (mode) => {
      setupMode = mode;
      returnTabName = document.querySelector(".tab.active")?.dataset.tab || "today";
      flowDirection.value = quizDirection.value || "en-ja";
      flowRange.value = quizRange.value || "all";
      flowOrder.value = quizOrder.value || "random";
      if (quizCount) {
        flowCount.value = quizCount.value || "10";
        if (quizCount.max) flowCount.max = quizCount.max;
      }


      const todayMode = mode === "today";
      flowSetupTitle.textContent = todayMode ? "今日の単語" : "問題設定";
      flowSetupStart.textContent = todayMode ? "学習を開始" : "問題を開始";
      flowRangeGroup.hidden = todayMode;
      flowOrderGroup.hidden = todayMode;
      flowCountGroup.hidden = todayMode || flowRange.value === "unanswered";


      if (typeof setupDialog.showModal === "function") {
        setupDialog.showModal();
      } else {
        setupDialog.setAttribute("open", "");
      }
      setTimeout(() => flowDirection.focus(), 0);
    };


    const closeSetup = () => {
      if (typeof setupDialog.close === "function") setupDialog.close();
      else setupDialog.removeAttribute("open");
    };


    const enterQuizOnly = () => {
      document.body.classList.add("quiz-only-mode");
      window.scrollTo({ top: 0, behavior: "instant" });
      if (skipBtn) {
        skipBtn.hidden = true;
        skipBtn.setAttribute("aria-hidden", "true");
        skipBtn.tabIndex = -1;
      }
      cleanIdleFeedback();
    };


    const exitQuizOnly = () => {
      if (!document.body.classList.contains("quiz-only-mode")) return;
      document.body.classList.remove("quiz-only-mode");
      const targetName = setupMode === "today" ? "today" : returnTabName;
      const target = document.querySelector(`.tab[data-tab="${targetName}"]`) || todayTab;
      if (!target) return;
      if (target.dataset.tab === "quiz") {
        allowQuizTab = true;
        target.click();
        allowQuizTab = false;
      } else {
        target.click();
      }
      window.scrollTo({ top: 0, behavior: "instant" });
    };


    const cleanIdleFeedback = () => {
      if (!feedback) return;
      const text = feedback.textContent.replace(/\s+/g, " ").trim();
      const isIdle = text.includes("回答を入力して") && text.includes("答え合わせ");
      feedback.classList.toggle("flow-idle-feedback", isIdle);
    };


    quizTab.addEventListener("click", (event) => {
      if (allowQuizTab || document.body.classList.contains("quiz-only-mode")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      openSetup("quiz");
    }, true);


    const interceptTodayStart = (button) => {
      button?.addEventListener("click", (event) => {
        if (allowTodayStart || document.body.classList.contains("quiz-only-mode")) return;
        if (button.disabled) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        openSetup("today");
      }, true);
    };
    interceptTodayStart(openTodayBtn);
    interceptTodayStart(startTodayBtn);


    flowRange.addEventListener("change", updateCountVisibility);
    document.getElementById("flowSetupClose").addEventListener("click", closeSetup);
    document.getElementById("flowSetupCancel").addEventListener("click", closeSetup);
    setupDialog.addEventListener("click", (event) => {
      if (event.target === setupDialog) closeSetup();
    });


    flowSetupStart.addEventListener("click", () => {
      quizDirection.value = flowDirection.value;
      dispatchChange(quizDirection);


      if (setupMode === "quiz") {
        quizRange.value = flowRange.value;
        dispatchChange(quizRange);
        quizOrder.value = flowOrder.value;
        dispatchChange(quizOrder);
        if (quizCount && flowRange.value !== "unanswered") {
          quizCount.value = flowCount.value || "1";
          quizCount.dispatchEvent(new Event("input", { bubbles: true }));
          dispatchChange(quizCount);
        }
        closeSetup();
        allowQuizTab = true;
        quizTab.click();
        allowQuizTab = false;
        setTimeout(enterQuizOnly, 0);
      } else {
        closeSetup();
        const sourceButton = openTodayBtn && !openTodayBtn.disabled ? openTodayBtn : startTodayBtn;
        if (!sourceButton) return;
        allowTodayStart = true;
        sourceButton.click();
        allowTodayStart = false;
        setTimeout(enterQuizOnly, 0);
      }
    });


    exitButton.addEventListener("click", exitQuizOnly);


    nextBtn?.addEventListener("click", () => {
      const isEnding = /終了/.test(nextBtn.textContent || "");
      if (isEnding) setTimeout(exitQuizOnly, 80);
    }, true);


    quizEmptyAction?.addEventListener("click", () => {
      document.body.classList.remove("quiz-only-mode");
    }, true);


    document.querySelectorAll('.tab:not([data-tab="quiz"])').forEach((tab) => {
      tab.addEventListener("click", () => {
        if (document.body.classList.contains("quiz-only-mode")) {
          document.body.classList.remove("quiz-only-mode");
        }
      }, true);
    });


    if (feedback) {
      cleanIdleFeedback();
      new MutationObserver(cleanIdleFeedback).observe(feedback, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["class"]
      });
    }


    if (skipBtn) {
      new MutationObserver(() => {
        skipBtn.hidden = true;
        skipBtn.setAttribute("aria-hidden", "true");
        skipBtn.tabIndex = -1;
      }).observe(skipBtn, { attributes: true, attributeFilter: ["hidden", "style", "class"] });
    }
  });
})();