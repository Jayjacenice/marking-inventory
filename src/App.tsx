import { useEffect, useState } from 'react';
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useNavigate,
} from 'react-router-dom';
import { supabase } from './lib/supabase';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/admin/Dashboard';
import WorkOrderUpload from './pages/admin/WorkOrderUpload';
import Downloads from './pages/admin/Downloads';
import BOMManage from './pages/admin/BOMManage';
import UserManage from './pages/admin/UserManage';
import InventoryUpload from './pages/admin/InventoryUpload';
import ShipmentConfirm from './pages/offline/ShipmentConfirm';
import ReceiptCheck from './pages/playwith/ReceiptCheck';
import MarkingWork from './pages/playwith/MarkingWork';
import ShipmentOut from './pages/playwith/ShipmentOut';
import TransferToShop from './pages/playwith/TransferToShop';
import ActivityHistory from './pages/admin/ActivityHistory';
import InventoryManage from './pages/admin/InventoryManage';
import StockLedger from './pages/admin/StockLedger';
import SalesUpload from './pages/admin/SalesUpload';
import TxHistory from './pages/admin/TxHistory';
import SKUMaster from './pages/admin/SKUMaster';
import OrderUpload from './pages/admin/OrderUpload';
import Progress from './pages/admin/Progress';
import MarkingRequest from './pages/admin/MarkingRequest';
import type { UserRole, AppUser } from './types';

function AppContent() {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewAs, setViewAs] = useState<UserRole | null>(null);
  const navigate = useNavigate();

  const defaultPaths: Record<UserRole, string> = {
    admin: '/admin/dashboard',
    offline: '/offline/shipment',
    playwith: '/playwith/receipt',
  };

  /**
   * Supabase user_profile을 조회해 AppUser를 설정한다.
   * shouldNavigate=true 이면 역할별 기본 페이지로 이동한다.
   * (실제 로그인 시에만 true, 세션 복원·토큰 갱신 시에는 false)
   */
  const loadUserProfile = async (
    userId: string,
    email: string,
    shouldNavigate: boolean
  ) => {
    try {
      const { data: profile } = await supabase
        .from('user_profile')
        .select('*')
        .eq('id', userId)
        .single();

      const appUser: AppUser = profile
        ? {
            id: userId,
            email,
            role: profile.role as UserRole,
            name: profile.name,
          }
        : { id: userId, email, role: 'admin', name: email };

      setUser(appUser);

      if (shouldNavigate) {
        navigate(defaultPaths[appUser.role]);
      }
    } catch (err) {
      console.error('loadUserProfile error:', err);
      // 예상치 못한 에러 → 로딩만 해제 (로그인 화면으로 자연스럽게 유도)
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    /**
     * onAuthStateChange를 단일 진실 원천으로 사용.
     *
     * 이벤트별 처리:
     *   INITIAL_SESSION - 앱 시작 시 기존 세션 복원 (navigate 없음)
     *   SIGNED_IN       - 실제 로그인 성공 (역할별 기본 페이지로 navigate)
     *   TOKEN_REFRESHED - JWT 자동 갱신 (navigate 없음, user 유지)
     *   SIGNED_OUT      - 로그아웃 (로그인 페이지로 navigate)
     *
     * 이중 안전망:
     * 1) getSession()을 3초 타임아웃으로 직접 호출 — 빠르게 초기 상태 결정
     * 2) onAuthStateChange로 후속 이벤트(로그인/로그아웃) 처리
     */
    let resolved = false;

    // 0) 절대 안전장치 — 어떤 이유로든 5초 내 loading이 해제되지 않으면 강제 해제
    //    (시크릿 모드 등에서 Supabase 초기화가 hang되는 경우 대비)
    const failsafeTimer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        setLoading(false);
      }
    }, 5_000);

    // 1) 직접 getSession — 3초 내 응답 없으면 세션 없음으로 처리
    const initSession = async () => {
      try {
        const result = await Promise.race([
          supabase.auth.getSession(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
        ]);
        if (resolved) return; // onAuthStateChange가 먼저 처리한 경우
        resolved = true;
        if (result && 'data' in result && result.data.session) {
          const s = result.data.session;
          await loadUserProfile(s.user.id, s.user.email || '', false);
        } else {
          setLoading(false);
        }
      } catch {
        if (!resolved) {
          resolved = true;
          setLoading(false);
        }
      }
    };
    initSession();

    // 2) 후속 이벤트 처리 (로그인, 로그아웃, 토큰 갱신)
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'INITIAL_SESSION') {
        // initSession이 이미 처리했을 가능성 높음
        if (resolved) return;
        resolved = true;
        if (session) {
          await loadUserProfile(session.user.id, session.user.email || '', false);
        } else {
          setLoading(false);
        }
      } else if (event === 'SIGNED_IN') {
        if (session) {
          await loadUserProfile(session.user.id, session.user.email || '', true);
        }
      } else if (event === 'SIGNED_OUT') {
        setUser(null);
        setLoading(false);
        navigate('/login');
      }
    });

    return () => {
      clearTimeout(failsafeTimer);
      subscription.unsubscribe();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="text-gray-400">로딩 중...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  const handleViewAsChange = (role: UserRole | null) => {
    setViewAs(role);
    if (role === 'offline') navigate('/offline/shipment');
    else if (role === 'playwith') navigate('/playwith/receipt');
    else navigate('/admin/dashboard');
  };

  return (
    <Layout
      role={user.role}
      userName={user.name}
      viewAs={viewAs}
      onViewAsChange={handleViewAsChange}
    >
      <Routes>
        {/* 관리자 */}
        <Route path="/admin/dashboard" element={<Dashboard currentUser={user} />} />
        <Route path="/admin/workorder" element={<WorkOrderUpload />} />
        <Route path="/admin/downloads" element={<Downloads />} />
        <Route path="/admin/bom" element={<BOMManage />} />
        <Route path="/admin/inventory" element={<InventoryUpload />} />
        <Route path="/admin/stock" element={<InventoryManage currentUserId={user.id} />} />
        {/* currentUserId를 prop으로 전달 → UserManage 내 getSession() 중복 제거 */}
        <Route path="/admin/users" element={<UserManage currentUserId={user.id} />} />
        <Route path="/admin/history" element={<ActivityHistory />} />
        <Route path="/admin/sales" element={<SalesUpload />} />
        <Route path="/admin/tx-history" element={<TxHistory />} />
        <Route path="/admin/stock-ledger" element={<StockLedger />} />
        <Route path="/admin/sku-master" element={<SKUMaster currentUserId={user.id} />} />
        <Route path="/admin/orders" element={<OrderUpload currentUserId={user.id} />} />
        <Route path="/admin/progress" element={<Progress />} />
        <Route path="/admin/marking-request" element={<MarkingRequest currentUser={user} />} />

        {/* 오프라인 매장 */}
        <Route path="/offline/shipment" element={<ShipmentConfirm currentUser={user} />} />

        {/* 플레이위즈 */}
        <Route path="/playwith/receipt" element={<ReceiptCheck currentUser={user} />} />
        <Route path="/playwith/marking" element={<MarkingWork currentUser={user} />} />
        <Route path="/playwith/shipment" element={<ShipmentOut currentUser={user} />} />
        <Route path="/playwith/transfer" element={<TransferToShop currentUser={user} />} />

        {/* 기본 리다이렉트 */}
        <Route
          path="*"
          element={
            <Navigate
              to={
                user.role === 'admin'
                  ? '/admin/dashboard'
                  : user.role === 'offline'
                  ? '/offline/shipment'
                  : '/playwith/receipt'
              }
              replace
            />
          }
        />
      </Routes>
    </Layout>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}
