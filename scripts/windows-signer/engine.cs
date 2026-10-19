// Motor de assinatura Authenticode do agente do YubiKey (scripts/windows-signer).
//
// Roda dentro de um powershell.exe 5.1 que o agente abre, compilado em memória
// pelo CodeDom do .NET Framework (C# 5: sem interpolação, sem `?.`). Ele segura o
// certificado fixado da loja do usuário e a chave do slot 9a e assina em processo
// por SignerSignEx2 (SHA-256, carimbo RFC 3161), conferindo cada arquivo.
//
// Três jeitos de destrancar a chave, um por processo:
// - UNLOCK: a janela de PIN do próprio Windows (o provedor de chaves do cartão).
//   O PIN fica no cache do provedor; este código nunca o vê.
// - UNLOCK_SAVE: a janela deste motor pede o PIN, o cartão o confere e só então
//   ele é guardado cifrado pelo DPAPI do usuário (decisão do operador, 19/10:
//   zero janela de PIN nesta máquina, aceitando o risco).
// - UNLOCK_STORED: lê o PIN guardado e o entrega ao cartão sem janela. Na primeira
//   recusa (PIN errado, bloqueado, guardado ilegível) o arquivo é apagado na hora:
//   um PIN errado guardado nunca gasta uma segunda tentativa do YubiKey.
// O PIN só passa pela memória deste processo, a caminho do cartão e do DPAPI:
// nunca vai a stdout, log, argumento ou variável de ambiente.
//
// Protocolo de linhas UTF-8 com o agente (texto livre sempre em base64):
//   início              -> CERT <der> <0|1 chave privada>   ou   FATAL <msg>
//   UNLOCK              -> UNLOCKED                        ou   ERR <msg>
//   UNLOCK_SAVE <arq>   -> UNLOCKED                        ou   ERR <msg>
//   UNLOCK_STORED <arq> -> UNLOCKED                        ou   ERR <msg>
//   PROBE               -> OK                              ou   LOCKED <msg>
//   SIGN <arq> <url>    -> OK                              ou   LOCKED <msg> | ERR <msg>
//   VERIFY <arq>        -> OK                              ou   ERR <msg>
// Fim do stdin encerra o processo (e o cache do PIN morre com ele). Sem
// certificado alternativo: a política de arquivos mora no agente.
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace NexusWindowsSigner
{
    public static class Engine
    {
        const uint CRYPT_ACQUIRE_CACHE_FLAG = 0x1;
        const uint CRYPT_ACQUIRE_SILENT_FLAG = 0x40;
        const uint CRYPT_ACQUIRE_WINDOW_HANDLE_FLAG = 0x80;
        const uint CRYPT_ACQUIRE_ONLY_NCRYPT_KEY_FLAG = 0x40000;
        const uint CERT_NCRYPT_KEY_SPEC = 0xFFFFFFFF;
        const uint NCRYPT_SILENT_FLAG = 0x40;
        const uint SIGNER_SUBJECT_FILE = 1;
        const uint SIGNER_CERT_STORE = 2;
        const uint SIGNER_CERT_POLICY_CHAIN_NO_ROOT = 8;
        const uint SIGNER_NO_ATTR = 0;
        const uint CALG_SHA_256 = 0x800C;
        const uint SIGNER_TIMESTAMP_RFC3161 = 2;
        const uint SPC_EXC_PE_PAGE_HASHES_FLAG = 0x10;
        const string OID_SHA256 = "2.16.840.1.101.3.4.2.1";
        const string USE_CONTEXT = "NexusIDE: assinar o build do Windows (um PIN para o agente de assinatura)";
        const string PIN_PROPERTY = "SmartCardPin";
        static readonly byte[] PIN_ENTROPY = Encoding.UTF8.GetBytes("NexusIDE windows-signer YubiKey PIN v1");

        // Falhas em que o cartão não chegou a julgar o PIN: YubiKey fora da porta,
        // leitor ou serviço de cartão parado. Só nelas o PIN guardado fica.
        static readonly int[] CARD_ABSENT = new int[] {
            unchecked((int)0x8010000A), // SCARD_E_TIMEOUT
            unchecked((int)0x8010000B), // SCARD_E_SHARING_VIOLATION
            unchecked((int)0x8010000C), // SCARD_E_NO_SMARTCARD
            unchecked((int)0x80100017), // SCARD_E_READER_UNAVAILABLE
            unchecked((int)0x8010001D), // SCARD_E_NO_SERVICE
            unchecked((int)0x8010001E), // SCARD_E_SERVICE_STOPPED
            unchecked((int)0x8010002E), // SCARD_E_NO_READERS_AVAILABLE
            unchecked((int)0x80100066), // SCARD_W_UNRESPONSIVE_CARD
            unchecked((int)0x80100067), // SCARD_W_UNPOWERED_CARD
            unchecked((int)0x80100069), // SCARD_W_REMOVED_CARD
            unchecked((int)0x80090030), // NTE_DEVICE_NOT_READY
            unchecked((int)0x80090035), // NTE_DEVICE_NOT_FOUND
        };

        [StructLayout(LayoutKind.Sequential)]
        struct SIGNER_FILE_INFO { public uint cbSize; public IntPtr pwszFileName; public IntPtr hFile; }

        [StructLayout(LayoutKind.Sequential)]
        struct SIGNER_SUBJECT_INFO { public uint cbSize; public IntPtr pdwIndex; public uint dwSubjectChoice; public IntPtr pSignerFileInfo; }

        [StructLayout(LayoutKind.Sequential)]
        struct SIGNER_CERT_STORE_INFO { public uint cbSize; public IntPtr pSigningCert; public uint dwCertPolicy; public IntPtr hCertStore; }

        [StructLayout(LayoutKind.Sequential)]
        struct SIGNER_CERT { public uint cbSize; public uint dwCertChoice; public IntPtr pCertStoreInfo; public IntPtr hwnd; }

        [StructLayout(LayoutKind.Sequential)]
        struct SIGNER_SIGNATURE_INFO { public uint cbSize; public uint algidHash; public uint dwAttrChoice; public IntPtr pAttrAuthcode; public IntPtr psAuthenticated; public IntPtr psUnauthenticated; }

        [StructLayout(LayoutKind.Sequential)]
        struct WINTRUST_FILE_INFO { public uint cbStruct; public IntPtr pcwszFilePath; public IntPtr hFile; public IntPtr pgKnownSubject; }

        [StructLayout(LayoutKind.Sequential)]
        struct WINTRUST_DATA
        {
            public uint cbStruct; public IntPtr pPolicyCallbackData; public IntPtr pSIPClientData;
            public uint dwUIChoice; public uint fdwRevocationChecks; public uint dwUnionChoice; public IntPtr pFile;
            public uint dwStateAction; public IntPtr hWVTStateData; public IntPtr pwszURLReference;
            public uint dwProvFlags; public uint dwUIContext; public IntPtr pSignatureSettings;
        }

        [DllImport("mssign32.dll", CharSet = CharSet.Unicode)]
        static extern int SignerSignEx2(uint dwFlags, IntPtr pSubjectInfo, IntPtr pSignerCert, IntPtr pSignatureInfo,
            IntPtr pProviderInfo, uint dwTimestampFlags, [MarshalAs(UnmanagedType.LPStr)] string pszTimestampAlgorithmOid,
            string pwszHttpTimeStamp, IntPtr psRequest, IntPtr pSipData, out IntPtr ppSignerContext,
            IntPtr pCryptoPolicy, IntPtr pReserved);

        [DllImport("mssign32.dll")]
        static extern int SignerFreeSignerContext(IntPtr pSignerContext);

        [DllImport("crypt32.dll", SetLastError = true)]
        static extern bool CryptAcquireCertificatePrivateKey(IntPtr pCert, uint dwFlags, IntPtr pvParameters,
            out IntPtr phCryptProvOrNCryptKey, out uint pdwKeySpec, out bool pfCallerFreeProvOrNCryptKey);

        [DllImport("ncrypt.dll", CharSet = CharSet.Unicode)]
        static extern int NCryptSetProperty(IntPtr hObject, string pszProperty, byte[] pbInput, int cbInput, uint dwFlags);

        [DllImport("ncrypt.dll")]
        static extern int NCryptSignHash(IntPtr hKey, IntPtr pPaddingInfo, byte[] pbHashValue, int cbHashValue,
            byte[] pbSignature, int cbSignature, out int pcbResult, uint dwFlags);

        [DllImport("wintrust.dll")]
        static extern int WinVerifyTrust(IntPtr hwnd, ref Guid pgActionID, ref WINTRUST_DATA pWVTData);

        [DllImport("user32.dll")]
        static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        static extern bool SetForegroundWindow(IntPtr hWnd);

        sealed class OwnerWindow : IWin32Window
        {
            readonly IntPtr handle;
            public OwnerWindow(IntPtr handle) { this.handle = handle; }
            public IntPtr Handle { get { return handle; } }
        }

        static readonly Guid GENERIC_VERIFY_V2 = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");

        static X509Certificate2 certificate;
        static IntPtr key = IntPtr.Zero;

        public static int Run(TextReader input, TextWriter output, string thumbprint)
        {
            try
            {
                certificate = FindCertificate(thumbprint);
            }
            catch (Exception error)
            {
                output.WriteLine("FATAL " + B64(error.Message));
                return 1;
            }
            if (certificate == null)
            {
                output.WriteLine("FATAL " + B64("certificate " + thumbprint + " is not in Cert:\\CurrentUser\\My"));
                return 1;
            }
            output.WriteLine("CERT " + Convert.ToBase64String(certificate.RawData) + " " + (certificate.HasPrivateKey ? "1" : "0"));

            string line;
            while ((line = input.ReadLine()) != null)
            {
                string[] parts = line.Split(' ');
                try
                {
                    output.WriteLine(Handle(parts));
                }
                catch (Exception error)
                {
                    output.WriteLine("ERR " + B64(error.Message));
                }
            }
            return 0;
        }

        static string Handle(string[] parts)
        {
            switch (parts[0])
            {
                case "UNLOCK":
                    Unlock();
                    return "UNLOCKED";
                case "UNLOCK_SAVE":
                    if (parts.Length != 2) throw new ArgumentException("UNLOCK_SAVE needs the PIN file");
                    UnlockAndSavePin(FromB64(parts[1]));
                    return "UNLOCKED";
                case "UNLOCK_STORED":
                    if (parts.Length != 2) throw new ArgumentException("UNLOCK_STORED needs the PIN file");
                    UnlockWithStoredPin(FromB64(parts[1]));
                    return "UNLOCKED";
                case "PROBE":
                    {
                        string locked = Probe();
                        return locked == null ? "OK" : "LOCKED " + B64(locked);
                    }
                case "SIGN":
                    {
                        if (parts.Length != 3) throw new ArgumentException("SIGN needs a file and a timestamp server");
                        string locked = Probe();
                        if (locked != null) return "LOCKED " + B64(locked);
                        string file = FromB64(parts[1]);
                        SignWithRetries(file, FromB64(parts[2]));
                        Verify(file);
                        return "OK";
                    }
                case "VERIFY":
                    if (parts.Length != 2) throw new ArgumentException("VERIFY needs a file");
                    Verify(FromB64(parts[1]));
                    return "OK";
                default:
                    throw new ArgumentException("unknown command");
            }
        }

        static X509Certificate2 FindCertificate(string thumbprint)
        {
            X509Store store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
            store.Open(OpenFlags.ReadOnly | OpenFlags.OpenExistingOnly);
            try
            {
                X509Certificate2Collection found = store.Certificates.Find(X509FindType.FindByThumbprint, thumbprint, false);
                return found.Count == 1 ? found[0] : null;
            }
            finally
            {
                store.Close();
            }
        }

        // A janela de PIN do Windows: dona da janela que estava à frente (o
        // terminal que abriu o build), com a descrição do Nexus. A chave fica no
        // cache do contexto do certificado, que o SignerSignEx2 reaproveita.
        static void Unlock()
        {
            AcquireKey(GetForegroundWindow(), false);
            byte[] context = Encoding.Unicode.GetBytes(USE_CONTEXT + "\0");
            NCryptSetProperty(key, "Use Context", context, context.Length, 0);
            int status = SignDummy(0);
            if (status != 0) throw new InvalidOperationException("the YubiKey did not unlock (0x" + status.ToString("X8") + ")");
        }

        static void AcquireKey(IntPtr owner, bool silent)
        {
            if (key != IntPtr.Zero) return;
            uint flags = CRYPT_ACQUIRE_CACHE_FLAG | CRYPT_ACQUIRE_ONLY_NCRYPT_KEY_FLAG | (silent ? CRYPT_ACQUIRE_SILENT_FLAG : 0);
            IntPtr ownerBox = IntPtr.Zero;
            try
            {
                if (owner != IntPtr.Zero)
                {
                    flags |= CRYPT_ACQUIRE_WINDOW_HANDLE_FLAG;
                    ownerBox = Marshal.AllocHGlobal(IntPtr.Size);
                    Marshal.WriteIntPtr(ownerBox, owner);
                }
                IntPtr acquired;
                uint keySpec;
                bool callerFrees;
                if (!CryptAcquireCertificatePrivateKey(certificate.Handle, flags, ownerBox, out acquired, out keySpec, out callerFrees))
                {
                    throw new CardException(Marshal.GetLastWin32Error(), "private key unavailable");
                }
                if (keySpec != CERT_NCRYPT_KEY_SPEC)
                {
                    throw new InvalidOperationException("the signing key is not a CNG key");
                }
                // Com CRYPT_ACQUIRE_CACHE_FLAG a chave pertence ao contexto do
                // certificado e vive com o processo.
                key = acquired;
            }
            finally
            {
                if (ownerBox != IntPtr.Zero) Marshal.FreeHGlobal(ownerBox);
            }
        }

        // Entrega o PIN ao provedor do cartão e prova com uma assinatura
        // silenciosa: 0 = destrancado. Os buffers com o PIN são zerados aqui.
        static int PresentPin(byte[] pinUtf8)
        {
            byte[] wide = null;
            try
            {
                byte[] text = Encoding.Convert(Encoding.UTF8, Encoding.Unicode, pinUtf8);
                wide = new byte[text.Length + 2];
                Buffer.BlockCopy(text, 0, wide, 0, text.Length);
                Array.Clear(text, 0, text.Length);
                int status = NCryptSetProperty(key, PIN_PROPERTY, wide, wide.Length, NCRYPT_SILENT_FLAG);
                return status != 0 ? status : SignDummy(NCRYPT_SILENT_FLAG);
            }
            finally
            {
                if (wide != null) Array.Clear(wide, 0, wide.Length);
            }
        }

        static bool CardAbsent(int status)
        {
            return Array.IndexOf(CARD_ABSENT, status) >= 0;
        }

        static void UnlockAndSavePin(string file)
        {
            AcquireKey(IntPtr.Zero, true);
            byte[] pin = PromptPin();
            if (pin == null) throw new InvalidOperationException("PIN entry was cancelled; nothing was saved");
            try
            {
                int status = PresentPin(pin);
                if (status != 0)
                {
                    throw new InvalidOperationException(CardAbsent(status)
                        ? "the YubiKey is not available (0x" + status.ToString("X8") + "); nothing was saved"
                        : "the YubiKey refused the PIN (0x" + status.ToString("X8") + "): it used one PIN attempt and nothing was saved");
                }
                byte[] sealedPin = ProtectedData.Protect(pin, PIN_ENTROPY, DataProtectionScope.CurrentUser);
                string temporary = file + ".tmp";
                File.WriteAllBytes(temporary, sealedPin);
                if (File.Exists(file)) File.Delete(file);
                File.Move(temporary, file);
            }
            finally
            {
                Array.Clear(pin, 0, pin.Length);
            }
        }

        static void UnlockWithStoredPin(string file)
        {
            if (!File.Exists(file)) throw new InvalidOperationException("no YubiKey PIN is saved");
            byte[] pin;
            try
            {
                pin = ProtectedData.Unprotect(File.ReadAllBytes(file), PIN_ENTROPY, DataProtectionScope.CurrentUser);
            }
            catch (CryptographicException)
            {
                File.Delete(file);
                throw new InvalidOperationException("the saved PIN could not be read by this Windows user; it was deleted");
            }
            try
            {
                try
                {
                    AcquireKey(IntPtr.Zero, true);
                }
                catch (CardException error)
                {
                    throw new InvalidOperationException("the YubiKey is not available (0x" + error.Status.ToString("X8") + "); the saved PIN was kept");
                }
                int status = PresentPin(pin);
                if (status == 0) return;
                if (CardAbsent(status))
                {
                    throw new InvalidOperationException("the YubiKey is not available (0x" + status.ToString("X8") + "); the saved PIN was kept");
                }
                File.Delete(file);
                throw new InvalidOperationException("the YubiKey refused the saved PIN (0x" + status.ToString("X8") + "): it was deleted, save it again");
            }
            finally
            {
                Array.Clear(pin, 0, pin.Length);
            }
        }

        // Janela deste motor (não a do provedor do cartão), porque o PIN precisa
        // ser guardado. Fica por cima das outras janelas e só aceita texto.
        //
        // O agente abre o motor com a janela oculta (windowsHide), e o Windows
        // aplica esse SW_HIDE do STARTUPINFO à PRIMEIRA ShowWindow do processo: a
        // caixa de PIN nascia invisível (19/10, save-pin esperou 5 min sem janela).
        // Uma janela vazia consome essa primeira chamada antes da caixa.
        static byte[] PromptPin()
        {
            byte[] result = null;
            IntPtr foreground = GetForegroundWindow();
            Thread thread = new Thread(delegate ()
            {
                Application.EnableVisualStyles();
                using (Form spent = new Form())
                {
                    ShowWindow(spent.Handle, 10); // SW_SHOWDEFAULT: recebe o SW_HIDE do STARTUPINFO
                }
                using (Form form = new Form())
                {
                    form.Text = "NexusIDE — PIN do YubiKey";
                    form.FormBorderStyle = FormBorderStyle.FixedDialog;
                    form.MaximizeBox = false;
                    form.MinimizeBox = false;
                    form.StartPosition = FormStartPosition.CenterScreen;
                    form.TopMost = true;
                    form.ShowInTaskbar = true;
                    form.Font = SystemFonts.MessageBoxFont;
                    form.ClientSize = new Size(460, 200);
                    Label label = new Label();
                    label.Text = "Digite o PIN do YubiKey (PIV) que assina os builds da HIPERSEND.\n\n" +
                        "Ele fica guardado neste usuário do Windows, cifrado pelo DPAPI, e o agente " +
                        "assina sem perguntar de novo. Se o YubiKey recusar o PIN, nada é guardado.";
                    label.SetBounds(16, 14, 428, 100);
                    TextBox box = new TextBox();
                    box.UseSystemPasswordChar = true;
                    box.MaxLength = 64;
                    box.SetBounds(16, 120, 428, 24);
                    Button ok = new Button();
                    ok.Text = "Guardar";
                    ok.DialogResult = DialogResult.OK;
                    ok.SetBounds(268, 158, 84, 28);
                    Button cancel = new Button();
                    cancel.Text = "Cancelar";
                    cancel.DialogResult = DialogResult.Cancel;
                    cancel.SetBounds(360, 158, 84, 28);
                    form.AcceptButton = ok;
                    form.CancelButton = cancel;
                    form.Controls.AddRange(new Control[] { label, box, ok, cancel });
                    form.Shown += delegate
                    {
                        form.Activate();
                        SetForegroundWindow(form.Handle);
                        box.Focus();
                    };
                    DialogResult answer = foreground != IntPtr.Zero
                        ? form.ShowDialog(new OwnerWindow(foreground))
                        : form.ShowDialog();
                    if (answer == DialogResult.OK && box.Text.Length > 0)
                    {
                        result = Encoding.UTF8.GetBytes(box.Text);
                    }
                    box.Text = "";
                }
            });
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            thread.Join();
            return result;
        }

        sealed class CardException : Exception
        {
            public readonly int Status;
            public CardException(int status, string message)
                : base(message + " (0x" + status.ToString("X8") + ")")
            {
                Status = status;
            }
        }

        // Assinatura silenciosa de um resumo aleatório: prova que o PIN continua no
        // cache sem nunca abrir janela. YubiKey removido, sono que reinicia o cartão
        // ou cache perdido viram LOCKED, e o agente encerra em vez de pedir PIN às
        // escondidas no meio de um build.
        static string Probe()
        {
            if (key == IntPtr.Zero) return "the agent is not unlocked";
            int status = SignDummy(NCRYPT_SILENT_FLAG);
            return status == 0 ? null : "the YubiKey PIN is no longer cached (0x" + status.ToString("X8") + ")";
        }

        static int SignDummy(uint flags)
        {
            byte[] digest = new byte[48];
            new Random().NextBytes(digest);
            int size;
            int status = NCryptSignHash(key, IntPtr.Zero, digest, digest.Length, null, 0, out size, flags);
            if (status != 0) return status;
            byte[] signature = new byte[size];
            return NCryptSignHash(key, IntPtr.Zero, digest, digest.Length, signature, signature.Length, out size, flags);
        }

        // F-656: o carimbo falha às vezes num arquivo qualquer (servidor lento ou
        // resposta truncada). Repetir a assinatura inteira substitui a anterior.
        static void SignWithRetries(string file, string timestampServer)
        {
            int[] waits = new int[] { 0, 3000, 8000 };
            int last = 0;
            for (int attempt = 0; attempt < waits.Length; attempt++)
            {
                if (waits[attempt] > 0) Thread.Sleep(waits[attempt]);
                last = Sign(file, timestampServer);
                if (last == 0) return;
            }
            throw new InvalidOperationException("SignerSignEx2 failed (0x" + last.ToString("X8") + ") after " + waits.Length + " attempts");
        }

        static int Sign(string file, string timestampServer)
        {
            IntPtr index = Marshal.AllocHGlobal(4);
            IntPtr fileName = Marshal.StringToHGlobalUni(file);
            IntPtr fileInfo = IntPtr.Zero, subject = IntPtr.Zero, storeInfo = IntPtr.Zero, signerCert = IntPtr.Zero, signatureInfo = IntPtr.Zero;
            IntPtr signerContext = IntPtr.Zero;
            try
            {
                Marshal.WriteInt32(index, 0);
                SIGNER_FILE_INFO fileInfoValue = new SIGNER_FILE_INFO();
                fileInfoValue.cbSize = (uint)Marshal.SizeOf(typeof(SIGNER_FILE_INFO));
                fileInfoValue.pwszFileName = fileName;
                fileInfo = Alloc(fileInfoValue);

                SIGNER_SUBJECT_INFO subjectValue = new SIGNER_SUBJECT_INFO();
                subjectValue.cbSize = (uint)Marshal.SizeOf(typeof(SIGNER_SUBJECT_INFO));
                subjectValue.pdwIndex = index;
                subjectValue.dwSubjectChoice = SIGNER_SUBJECT_FILE;
                subjectValue.pSignerFileInfo = fileInfo;
                subject = Alloc(subjectValue);

                SIGNER_CERT_STORE_INFO storeInfoValue = new SIGNER_CERT_STORE_INFO();
                storeInfoValue.cbSize = (uint)Marshal.SizeOf(typeof(SIGNER_CERT_STORE_INFO));
                storeInfoValue.pSigningCert = certificate.Handle;
                storeInfoValue.dwCertPolicy = SIGNER_CERT_POLICY_CHAIN_NO_ROOT;
                storeInfo = Alloc(storeInfoValue);

                SIGNER_CERT signerCertValue = new SIGNER_CERT();
                signerCertValue.cbSize = (uint)Marshal.SizeOf(typeof(SIGNER_CERT));
                signerCertValue.dwCertChoice = SIGNER_CERT_STORE;
                signerCertValue.pCertStoreInfo = storeInfo;
                signerCert = Alloc(signerCertValue);

                SIGNER_SIGNATURE_INFO signatureInfoValue = new SIGNER_SIGNATURE_INFO();
                signatureInfoValue.cbSize = (uint)Marshal.SizeOf(typeof(SIGNER_SIGNATURE_INFO));
                signatureInfoValue.algidHash = CALG_SHA_256;
                signatureInfoValue.dwAttrChoice = SIGNER_NO_ATTR;
                signatureInfo = Alloc(signatureInfoValue);

                return SignerSignEx2(SPC_EXC_PE_PAGE_HASHES_FLAG, subject, signerCert, signatureInfo, IntPtr.Zero,
                    SIGNER_TIMESTAMP_RFC3161, OID_SHA256, timestampServer, IntPtr.Zero, IntPtr.Zero, out signerContext,
                    IntPtr.Zero, IntPtr.Zero);
            }
            finally
            {
                if (signerContext != IntPtr.Zero) SignerFreeSignerContext(signerContext);
                Marshal.FreeHGlobal(index);
                Marshal.FreeHGlobal(fileName);
                Free(fileInfo); Free(subject); Free(storeInfo); Free(signerCert); Free(signatureInfo);
            }
        }

        // Assinatura válida para o Windows (cadeia até a raiz confiável) e feita por
        // este certificado: outra assinatura no arquivo é falha, não sucesso.
        static void Verify(string file)
        {
            IntPtr path = Marshal.StringToHGlobalUni(file);
            IntPtr fileInfo = IntPtr.Zero;
            try
            {
                WINTRUST_FILE_INFO fileInfoValue = new WINTRUST_FILE_INFO();
                fileInfoValue.cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_FILE_INFO));
                fileInfoValue.pcwszFilePath = path;
                fileInfo = Alloc(fileInfoValue);
                WINTRUST_DATA data = new WINTRUST_DATA();
                data.cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_DATA));
                data.dwUIChoice = 2;           // WTD_UI_NONE
                data.fdwRevocationChecks = 0;  // WTD_REVOKE_NONE
                data.dwUnionChoice = 1;        // WTD_CHOICE_FILE
                data.pFile = fileInfo;
                data.dwStateAction = 1;        // WTD_STATEACTION_VERIFY
                data.dwProvFlags = 0x10;       // WTD_REVOCATION_CHECK_NONE
                Guid action = GENERIC_VERIFY_V2;
                int trust = WinVerifyTrust(IntPtr.Zero, ref action, ref data);
                data.dwStateAction = 2;        // WTD_STATEACTION_CLOSE
                WinVerifyTrust(IntPtr.Zero, ref action, ref data);
                if (trust != 0) throw new InvalidOperationException("Windows does not trust the signature (0x" + trust.ToString("X8") + ")");
            }
            finally
            {
                Free(fileInfo);
                Marshal.FreeHGlobal(path);
            }
            X509Certificate signer = X509Certificate.CreateFromSignedFile(file);
            if (!string.Equals(signer.GetCertHashString(), certificate.Thumbprint, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("the file is signed by " + signer.GetCertHashString() + ", not by the pinned certificate");
            }
        }

        static IntPtr Alloc<T>(T value) where T : struct
        {
            IntPtr pointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(T)));
            Marshal.StructureToPtr(value, pointer, false);
            return pointer;
        }

        static void Free(IntPtr pointer)
        {
            if (pointer != IntPtr.Zero) Marshal.FreeHGlobal(pointer);
        }

        static string B64(string text)
        {
            return Convert.ToBase64String(Encoding.UTF8.GetBytes(text ?? ""));
        }

        static string FromB64(string text)
        {
            return Encoding.UTF8.GetString(Convert.FromBase64String(text));
        }
    }
}
