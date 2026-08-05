(() => {
  "use strict";

  if (window.AndroidAccount && typeof window.AndroidAccount.getStatus === "function") return;

  const FIREBASE_SDK_VERSION = "12.16.0";
  const FIREBASE_SDK_BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;
  const MAX_PAYLOAD_BYTES = 900000;
  const firebaseConfig = {
    apiKey: "AIzaSyA8lvJbeos_sX_WVVT3UA8eCkq7atV748o",
    authDomain: "minna-tangocho-536e5.firebaseapp.com",
    projectId: "minna-tangocho-536e5",
    storageBucket: "minna-tangocho-536e5.firebasestorage.app",
    messagingSenderId: "963708814072",
    appId: "1:963708814072:android:98324ec41d461a5fc7f10d"
  };

  let configured = false;
  let auth = null;
  let firestore = null;
  let authSdk = null;
  let firestoreSdk = null;
  let currentUser = null;
  let unsubscribeCloud = null;

  function emit(detail) {
    window.dispatchEvent(new CustomEvent("minna-account", { detail }));
  }

  function emitAuth(user, message = "") {
    emit({
      type: "auth",
      configured,
      signedIn: Boolean(user),
      email: user?.email || "",
      emailVerified: user?.emailVerified === true,
      message
    });
  }

  function emitError(message) {
    emit({ type: "error", message });
  }

  function authErrorMessage(error) {
    const code = String(error?.code || "");
    if (code === "auth/invalid-email") return "メールアドレスの形式が正しくありません。";
    if (code === "auth/email-already-in-use") return "このメールアドレスは既に登録されています。";
    if (code === "auth/weak-password") return "より強いパスワードを設定してください。";
    if (["auth/wrong-password", "auth/user-not-found", "auth/invalid-credential"].includes(code)) {
      return "メールアドレスまたはパスワードが正しくありません。";
    }
    if (code === "auth/too-many-requests") return "試行回数が多すぎます。時間を置いてください。";
    if (code === "auth/network-request-failed") return "通信できません。ネットワークを確認してください。";
    if (code === "auth/requires-recent-login") return "安全のため、いったんログアウトして再ログインしてから操作してください。";
    return "認証処理に失敗しました。時間を置いて再試行してください。";
  }

  function stopCloudListener() {
    if (typeof unsubscribeCloud === "function") unsubscribeCloud();
    unsubscribeCloud = null;
  }

  function activeUser() {
    return currentUser || auth?.currentUser || null;
  }

  function verifiedUser() {
    const user = activeUser();
    if (!user) {
      emitError("先にログインしてください。");
      return null;
    }
    if (!user.emailVerified) {
      emitError("メール確認を完了してから同期してください。");
      return null;
    }
    return user;
  }

  function userDocument(user = activeUser()) {
    if (!user) throw new Error("ログインが必要");
    return firestoreSdk.doc(firestore, "users", user.uid, "private", "appData");
  }

  function emitCloudSnapshot(snapshot) {
    const data = snapshot.exists() ? snapshot.data() : null;
    const timestamp = data?.updatedAt;
    emit({
      type: "cloudData",
      exists: snapshot.exists(),
      payload: typeof data?.payload === "string" ? data.payload : "",
      updatedAt: typeof timestamp?.toDate === "function" ? timestamp.toDate().toISOString() : ""
    });
  }

  function startCloudListener() {
    const user = verifiedUser();
    if (!user) return;
    stopCloudListener();
    unsubscribeCloud = firestoreSdk.onSnapshot(
      userDocument(user),
      { includeMetadataChanges: true },
      (snapshot) => {
        if (snapshot.metadata.fromCache) return;
        emitCloudSnapshot(snapshot);
      },
      () => emitError("クラウドデータを読み込めませんでした。")
    );
  }

  function run(task, errorFormatter = authErrorMessage) {
    ready
      .then(() => {
        if (!configured) throw new Error("Firebase is not configured");
        return task();
      })
      .catch((error) => {
        console.error(error);
        emitError(errorFormatter(error));
      });
  }

  const bridge = {
    getStatus() {
      const user = activeUser();
      return JSON.stringify({
        configured,
        signedIn: Boolean(user),
        email: user?.email || "",
        emailVerified: user?.emailVerified === true
      });
    },

    signUp(email, password) {
      run(async () => {
        const cleanEmail = String(email || "").trim();
        if (!cleanEmail || String(password || "").length < 8) {
          emitError("メールアドレスと8文字以上のパスワードを入力してください。");
          return;
        }
        const result = await authSdk.createUserWithEmailAndPassword(auth, cleanEmail, String(password));
        currentUser = result.user;
        await authSdk.sendEmailVerification(result.user);
        emitAuth(result.user, "確認メールを送りました。メール内のリンクを開いてください。");
      });
    },

    signIn(email, password) {
      run(async () => {
        const cleanEmail = String(email || "").trim();
        if (!cleanEmail || !password) {
          emitError("メールアドレスとパスワードを入力してください。");
          return;
        }
        const result = await authSdk.signInWithEmailAndPassword(auth, cleanEmail, String(password));
        currentUser = result.user;
        emitAuth(result.user);
        if (result.user.emailVerified) startCloudListener();
      });
    },

    signOut() {
      run(async () => {
        stopCloudListener();
        await authSdk.signOut(auth);
        currentUser = null;
        emitAuth(null);
      });
    },

    sendPasswordReset(email) {
      run(async () => {
        const cleanEmail = String(email || "").trim();
        if (!cleanEmail) {
          emitError("メールアドレスを入力してください。");
          return;
        }
        await authSdk.sendPasswordResetEmail(auth, cleanEmail);
        emit({ type: "message", message: "パスワード再設定メールを送りました。" });
      });
    },

    resendVerification() {
      run(async () => {
        const user = activeUser();
        if (!user) {
          emitError("先にログインしてください。");
          return;
        }
        await authSdk.sendEmailVerification(user);
        emit({ type: "message", message: "確認メールを再送しました。" });
      });
    },

    refreshVerification() {
      run(async () => {
        const user = activeUser();
        if (!user) {
          emitAuth(null);
          return;
        }
        await authSdk.reload(user);
        currentUser = auth.currentUser;
        if (currentUser?.emailVerified) await authSdk.getIdToken(currentUser, true);
        emitAuth(
          currentUser,
          currentUser?.emailVerified ? "メール確認が完了しました。" : "メール確認はまだ完了していません。"
        );
        if (currentUser?.emailVerified) startCloudListener();
      });
    },

    startListening() {
      run(async () => startCloudListener(), () => "クラウドデータを読み込めませんでした。");
    },

    pushData(payload) {
      run(async () => {
        const user = verifiedUser();
        if (!user) return;
        const serialized = String(payload || "");
        if (!serialized || new TextEncoder().encode(serialized).length > MAX_PAYLOAD_BYTES) {
          emitError("同期データが大きすぎます。JSONバックアップを利用してください。");
          return;
        }
        try {
          JSON.parse(serialized);
        } catch {
          emitError("同期データの形式が正しくありません。");
          return;
        }
        await firestoreSdk.setDoc(userDocument(user), {
          payload: serialized,
          schemaVersion: 7,
          updatedAt: firestoreSdk.serverTimestamp()
        });
        emit({ type: "sync", state: "synced", message: "同期済み" });
      }, () => "クラウドへの保存に失敗しました。通信状態を確認してください。");
    },

    deleteAccount() {
      run(async () => {
        const user = activeUser();
        if (!user) {
          emitError("先にログインしてください。");
          return;
        }
        await firestoreSdk.deleteDoc(userDocument(user));
        stopCloudListener();
        await authSdk.deleteUser(user);
        currentUser = null;
        emitAuth(null, "アカウントとクラウドデータを削除しました。");
      });
    }
  };

  window.WebAccount = bridge;

  const ready = (async () => {
    const [appSdk, loadedAuthSdk, loadedFirestoreSdk] = await Promise.all([
      import(`${FIREBASE_SDK_BASE}/firebase-app.js`),
      import(`${FIREBASE_SDK_BASE}/firebase-auth.js`),
      import(`${FIREBASE_SDK_BASE}/firebase-firestore.js`)
    ]);
    const app = appSdk.initializeApp(firebaseConfig);
    authSdk = loadedAuthSdk;
    firestoreSdk = loadedFirestoreSdk;
    auth = authSdk.getAuth(app);
    firestore = firestoreSdk.getFirestore(app);
    try {
      await authSdk.setPersistence(auth, authSdk.browserLocalPersistence);
    } catch (error) {
      console.warn("ログイン状態の保存を設定できませんでした。", error);
    }
    configured = true;
    authSdk.onAuthStateChanged(auth, (user) => {
      if (currentUser?.uid !== user?.uid) stopCloudListener();
      currentUser = user;
      emitAuth(user);
      if (user?.emailVerified) startCloudListener();
    });
  })().catch((error) => {
    console.error("Firebaseの初期化に失敗しました。", error);
    configured = false;
    emitAuth(null, "クラウドへ接続できませんでした。通信状態を確認してください。");
  });
})();
