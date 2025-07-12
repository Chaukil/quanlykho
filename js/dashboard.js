import { 
    showConfirmation, 
    loadCacheData, 
    initializeWarehouseFunctions,
    loadImportSection,
    loadExportSection,
    loadTransferSection,
    loadAdjustSection,
    loadHistorySection,
    loadRequestAdjustSection,
    loadPendingAdjustmentsSection,
    loadPrintBarcodeSection,
    loadScanBarcodeSection 
} from './warehouse.js';


import { auth, db } from './connect.js';
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import {
    doc,
    getDoc,
    collection,
    query,
    where,
    getDocs,
    orderBy,
    limit,
    addDoc,        // Thêm dòng này
    updateDoc,     // Thêm dòng này
    serverTimestamp,
    writeBatch
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import { showToast } from './auth.js';

let currentUser = null;
let userRole = null;
let currentDashboardPage = 1;
let dashboardItemsPerPage = 15;
let filteredDashboardData = [];
let allDashboardData = [];
let userSettings = {};
let warehouseFunctionsInitialized = false;

window.loadInventoryTable = loadInventoryTable;
window.goToDashboardPage = goToDashboardPage;

// Trong file dashboard.js

document.addEventListener('DOMContentLoaded', function () {
    // Nạp cache dữ liệu kho hàng
    loadCacheData(); 
    
    sessionStorage.removeItem('auth_redirect_processed');
    
    // Khởi tạo các thành phần chính của trang
    initializeNavigation();
    initializeAuth();
    initializeSettingsListeners();
    
    // KHỞI TẠO CÁC NÚT BẤM VÀ CHỨC NĂNG CỦA KHO HÀNG
    initializeWarehouseFunctions(); 
});


function goToDashboardPage(page) {
    if (page >= 1) {
        loadInventoryTable(true, page);
    }
}

// Initialize authentication state
function initializeAuth() { 
    onAuthStateChanged(auth, async (user) => {
        
        if (!user) {
            window.location.href = 'index.html';
            return;
        }

        try {
            const userDoc = await getDoc(doc(db, 'users', user.uid));
            if (userDoc.exists()) {
                const userData = userDoc.data();
                
                if (userData.status !== 'approved') {
                    await signOut(auth);
                    window.location.href = 'index.html';
                    return;
                }
                
                currentUser = { ...userData, uid: user.uid };
                userRole = userData.role;
                
                loadSettings();

                setupUserInterface();
                loadDashboardData();
                updateUserManagementBadge();
            } else {
                console.log('User doc not found, signing out');
                await signOut(auth);
                window.location.href = 'index.html';
            }
        } catch (error) {
            console.error('Error loading user data:', error);
            showToast('Lỗi tải dữ liệu người dùng', 'danger');
            await signOut(auth);
            window.location.href = 'index.html';
        }
    });
}

// Trong dashboard.js
function setupUserInterface() {
    document.getElementById('userGreeting').textContent = `Hi, ${currentUser.name}`;

    if (userRole === 'staff') {
        // Hide admin and super admin sections
        document.querySelectorAll('.admin-only, .super-admin-only').forEach(element => {
            element.style.display = 'none';
        });
        // THÊM MỚI: Ẩn các tính năng riêng lẻ chỉ dành cho admin trở lên
        document.querySelectorAll('.admin-only-feature').forEach(element => {
            element.style.display = 'none';
        });
    } else if (userRole === 'admin') {
        // Show admin features but hide super admin features
        document.querySelectorAll('.admin-only, .admin-only-feature').forEach(element => {
            element.style.display = 'block';
        });
        document.querySelectorAll('.super-admin-only').forEach(element => {
            element.style.display = 'none';
        });
    } else if (userRole === 'super_admin') {
        // Show all features for super admin
        document.querySelectorAll('.admin-only, .super-admin-only, .admin-only-feature').forEach(element => {
            element.style.display = 'block';
        });
        
        const requestAdjustNav = document.querySelector('[data-section="request-adjust"]');
        if (requestAdjustNav) {
            requestAdjustNav.parentElement.style.display = 'none';
        }
    }

    // Setup logout button
    document.getElementById('logoutBtn').addEventListener('click', async () => {
        try {
            await signOut(auth);
            window.location.href = 'index.html';
        } catch (error) {
            showToast('Lỗi đăng xuất', 'danger');
        }
    });
}


// Initialize navigation
function initializeNavigation() {
    const navLinks = document.querySelectorAll('.nav-link[data-section]');

    navLinks.forEach(link => {
        link.addEventListener('click', function (e) {
            e.preventDefault();

            // Remove active class from all links
            navLinks.forEach(l => l.classList.remove('active'));

            // Add active class to clicked link
            this.classList.add('active');

            // Show corresponding section
            const section = this.getAttribute('data-section');
            showSection(section);
        });
    });
}

// Show specific section
function showSection(sectionName) {
    // Hide all sections
    document.querySelectorAll('.content-section').forEach(section => {
        section.style.display = 'none';
    });

    // Show selected section
    const targetSection = document.getElementById(`${sectionName}-section`);
    if (targetSection) {
        targetSection.style.display = 'block';

        // Load section-specific data
        loadSectionData(sectionName);
    }
}

// Load section-specific data
function loadSectionData(sectionName) {
    switch (sectionName) {
        case 'dashboard':
            loadDashboardData();
            break;
        case 'import':
            // Gọi trực tiếp hàm đã import
            loadImportSection();
            break;
        case 'export':
            loadExportSection();
            break;
        case 'transfer':
            loadTransferSection();
            break;
        case 'adjust':
            if (userRole === 'super_admin') {
                loadAdjustSection();
            } else {
                showToast('Bạn không có quyền truy cập chức năng này', 'danger');
            }
            break;
        case 'request-adjust':
            if (userRole === 'admin') {
                loadRequestAdjustSection();
            } else {
                showToast('Bạn không có quyền truy cập chức năng này', 'danger');
            }
            break;
        case 'pending-adjustments':
            if (userRole === 'super_admin') {
                loadPendingAdjustmentsSection();
            }
            break;
        case 'history':
            loadHistorySection();
            break;
        case 'print-barcode':
            loadPrintBarcodeSection();
            break;
        case 'scan-barcode':
            loadScanBarcodeSection();
            break;
        case 'user-management':
            if (userRole === 'super_admin') {
                loadUserManagementSection();
            }
            break;
    }
}


// Load dashboard data
async function loadDashboardData() {
    try {
        await loadInventorySummary();
        await loadTodayStatistics();
        await loadInventoryTable();
        initializeDashboardFilters();
        
        // Kiểm tra pending adjustments cho Super Admin
        if (userRole === 'super_admin') {
            checkPendingAdjustments();
        }

    } catch (error) {
        console.error('Error loading dashboard data:', error);
        showToast('Lỗi tải dữ liệu dashboard', 'danger');
    }
}

// Load inventory summary
async function loadInventorySummary() {
    try {
        const inventoryQuery = query(collection(db, 'inventory'));
        const snapshot = await getDocs(inventoryQuery);

        let totalProducts = 0;
        let lowStock = 0;

        snapshot.forEach(doc => {
            const data = doc.data();
            totalProducts++;
            if (data.quantity < 10) { // Assuming low stock threshold is 10
                lowStock++;
            }
        });

        document.getElementById('totalProducts').textContent = totalProducts;
        document.getElementById('lowStock').textContent = lowStock;

    } catch (error) {
        console.error('Error loading inventory summary:', error);
    }
}

// Load today's statistics
async function loadTodayStatistics() {
    try {
        const today = new Date();
        const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());

        // Load imports
        const importsQuery = query(
            collection(db, 'transactions'),
            where('type', '==', 'import'),
            where('date', '>=', startOfDay)
        );
        const importsSnapshot = await getDocs(importsQuery);
        document.getElementById('todayImports').textContent = importsSnapshot.size;

        // Load exports
        const exportsQuery = query(
            collection(db, 'transactions'),
            where('type', '==', 'export'),
            where('date', '>=', startOfDay)
        );
        const exportsSnapshot = await getDocs(exportsQuery);
        document.getElementById('todayExports').textContent = exportsSnapshot.size;

    } catch (error) {
        console.error('Error loading today statistics:', error);
    }
}

function loadUserManagementSection() {
    if (userRole !== 'super_admin') return;
    loadUsersTable();
    document.getElementById('filterUsersBtn')?.addEventListener('click', () => loadUsersTable(true));
    document.getElementById('clearUserFilterBtn')?.addEventListener('click', clearUserFilters);
}

function clearUserFilters() {
    document.getElementById('userNameFilter').value = '';
    document.getElementById('userRoleFilter').value = '';
    document.getElementById('userStatusFilter').value = '';
    loadUsersTable();
}

async function loadUsersTable(useFilter = false) {
    if (userRole !== 'super_admin') return;

    try {
        const usersQuery = query(collection(db, 'users'), orderBy('createdAt', 'desc'));
        const snapshot = await getDocs(usersQuery);

        let users = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        // Lọc dữ liệu (giữ nguyên)
        if (useFilter) {
            const nameFilter = document.getElementById('userNameFilter').value.toLowerCase();
            const roleFilter = document.getElementById('userRoleFilter').value;
            const statusFilter = document.getElementById('userStatusFilter').value;

            users = users.filter(user => {
                const nameMatch = nameFilter === '' || user.name.toLowerCase().includes(nameFilter) || user.email.toLowerCase().includes(nameFilter);
                const roleMatch = roleFilter === '' || user.role === roleFilter;
                const statusMatch = statusFilter === '' || user.status === statusFilter;
                return nameMatch && roleMatch && statusMatch;
            });
        }

        const content = document.getElementById('userManagementContent');
        content.innerHTML = '';

        if (users.length === 0) {
            content.innerHTML = '<p class="text-muted">Không tìm thấy người dùng nào.</p>';
            return;
        }

        const table = document.createElement('table');
        table.className = 'table table-striped';
        table.innerHTML = `
            <thead>
                <tr>
                    <th>Họ tên</th>
                    <th>Email</th>
                    <th>Vai trò</th>
                    <th>Trạng thái</th>
                    <th>Ngày tạo</th>
                    <th>Thao tác</th>
                </tr>
            </thead>
            <tbody></tbody>
        `;
        const tbody = table.querySelector('tbody');

        users.forEach(user => {
            const row = document.createElement('tr');
            if (user.status === 'pending') row.classList.add('table-warning');
            if (user.status === 'rejected') row.classList.add('table-danger', 'bg-opacity-10');

            const statusConfig = {
                'approved': { class: 'bg-success', text: 'Đã duyệt' },
                'pending': { class: 'bg-warning text-dark', text: 'Chờ duyệt' },
                'rejected': { class: 'bg-danger', text: 'Đã từ chối' },
                'disabled': { class: 'bg-secondary', text: 'Vô hiệu hóa' }
            };
            const statusInfo = statusConfig[user.status] || { class: 'bg-dark', text: user.status };

            const roleConfig = {
                'super_admin': { class: 'bg-danger', text: 'Super Admin' },
                'admin': { class: 'bg-primary', text: 'Admin' },
                'staff': { class: 'bg-info text-dark', text: 'Staff' }
            };
            const roleInfo = roleConfig[user.role] || { class: 'bg-secondary', text: user.role };
            
            const createdAt = user.createdAt ? user.createdAt.toDate().toLocaleDateString('vi-VN') : 'N/A';

            // --- LOGIC HIỂN THỊ BUTTON ĐỘNG ---
            let actionButtonsHtml = '';
            const isCurrentUser = currentUser.uid === user.id; // Không cho thao tác trên chính mình

            switch (user.status) {
                case 'pending':
                    actionButtonsHtml = `
                        <button class="btn btn-success btn-sm me-1" onclick="approveUser('${user.id}', '${user.name}')" ${isCurrentUser ? 'disabled' : ''} title="Chấp nhận">
                            <i class="fas fa-check"></i>
                        </button>
                        <button class="btn btn-danger btn-sm" onclick="rejectUser('${user.id}', '${user.name}')" ${isCurrentUser ? 'disabled' : ''} title="Từ chối">
                            <i class="fas fa-times"></i>
                        </button>
                    `;
                    break;
                case 'rejected':
                    actionButtonsHtml = `
                        <button class="btn btn-info btn-sm" onclick="restoreUser('${user.id}', '${user.name}')" ${isCurrentUser ? 'disabled' : ''} title="Khôi phục yêu cầu">
                            <i class="fas fa-undo"></i> Khôi phục
                        </button>
                    `;
                    break;
                default: // 'approved' và 'disabled'
                    actionButtonsHtml = `
                        <button class="btn btn-warning btn-sm" onclick="showEditUserModal('${user.id}')" ${isCurrentUser ? 'disabled' : ''}>
                            <i class="fas fa-edit"></i> Sửa
                        </button>
                    `;
                    break;
            }

            row.innerHTML = `
                <td>${user.name}</td>
                <td>${user.email}</td>
                <td><span class="badge ${roleInfo.class}">${roleInfo.text}</span></td>
                <td><span class="badge ${statusInfo.class}">${statusInfo.text}</span></td>
                <td>${createdAt}</td>
                <td>${actionButtonsHtml}</td>
            `;
            tbody.appendChild(row);
        });

        content.appendChild(table);

    } catch (error) {
        console.error('Error loading users:', error);
        showToast('Lỗi tải danh sách người dùng', 'danger');
    }
}

window.approveUser = async function(userId, userName) {
    const confirmed = await showConfirmation(
        'Xác nhận chấp nhận',
        `Bạn có chắc muốn chấp nhận và kích hoạt tài khoản cho <strong>${userName}</strong>?`,
        'Chấp nhận', 'Hủy', 'success'
    );
    if (!confirmed) return;

    try {
        const userDocRef = doc(db, 'users', userId);
        const userDoc = await getDoc(userDocRef);
        if (!userDoc.exists()) {
            showToast('Không tìm thấy người dùng!', 'danger');
            return;
        }

        const batch = writeBatch(db);
        // Cập nhật trạng thái user
        batch.update(userDocRef, { status: 'approved' });

        // Ghi log giao dịch loại 'user_approval'
        const logRef = doc(collection(db, 'transactions'));
        batch.set(logRef, {
            type: 'user_approval',
            action: 'approved',
            userId: userId,
            userName: userDoc.data().name,
            userEmail: userDoc.data().email,
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            timestamp: serverTimestamp()
        });
        
        await batch.commit();
        showToast(`Đã chấp nhận tài khoản cho ${userName}!`, 'success');
        loadUsersTable();
        updateUserManagementBadge();
    } catch (error) {
        console.error('Error approving user:', error);
        showToast('Lỗi khi chấp nhận người dùng', 'danger');
    }
};

/**
 * Từ chối tài khoản người dùng đang chờ duyệt.
 */
window.rejectUser = async function(userId, userName) {
    const confirmed = await showConfirmation(
        'Xác nhận từ chối',
        `Bạn có chắc muốn từ chối yêu cầu tài khoản của <strong>${userName}</strong>?`,
        'Từ chối', 'Hủy', 'danger'
    );
    if (!confirmed) return;

    try {
        const userDocRef = doc(db, 'users', userId);
        const userDoc = await getDoc(userDocRef);
        if (!userDoc.exists()) {
            showToast('Không tìm thấy người dùng!', 'danger');
            return;
        }

        const batch = writeBatch(db);
        // Cập nhật trạng thái user
        batch.update(userDocRef, { status: 'rejected' });

        // Ghi log giao dịch
        const logRef = doc(collection(db, 'transactions'));
        batch.set(logRef, {
            type: 'user_approval',
            action: 'rejected',
            userId: userId,
            userName: userDoc.data().name,
            userEmail: userDoc.data().email,
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            timestamp: serverTimestamp()
        });

        await batch.commit();
        showToast(`Đã từ chối tài khoản của ${userName}.`, 'success');
        loadUsersTable();
        updateUserManagementBadge();
    } catch (error) {
        console.error('Error rejecting user:', error);
        showToast('Lỗi khi từ chối người dùng', 'danger');
    }
};

/**
 * Khôi phục tài khoản đã bị từ chối về trạng thái chờ duyệt.
 */
window.restoreUser = async function(userId, userName) {
    const confirmed = await showConfirmation(
        'Xác nhận khôi phục',
        `Bạn có chắc muốn khôi phục yêu cầu cho <strong>${userName}</strong>? Tài khoản sẽ trở về trạng thái "Chờ duyệt".`,
        'Khôi phục', 'Hủy', 'info'
    );
    if (!confirmed) return;

    try {
        const userDocRef = doc(db, 'users', userId);
        const userDoc = await getDoc(userDocRef);
        if (!userDoc.exists()) {
            showToast('Không tìm thấy người dùng!', 'danger');
            return;
        }

        const batch = writeBatch(db);
        // Cập nhật trạng thái user
        batch.update(userDocRef, { status: 'pending' });

        // Ghi log giao dịch loại 'user_management' vì đây là hành động chỉnh sửa
        const logRef = doc(collection(db, 'transactions'));
        batch.set(logRef, {
            type: 'user_management',
            userId: userId,
            userName: userDoc.data().name,
            userEmail: userDoc.data().email,
            changes: {
                status: { from: 'rejected', to: 'pending' }
            },
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            timestamp: serverTimestamp()
        });

        await batch.commit();
        showToast(`Đã khôi phục yêu cầu cho ${userName}.`, 'success');
        loadUsersTable();
        updateUserManagementBadge();
    } catch (error) {
        console.error('Error restoring user:', error);
        showToast('Lỗi khi khôi phục người dùng', 'danger');
    }
};

window.showEditUserModal = async function(userId) {
    if (userRole !== 'super_admin') return;

    try {
        const userDoc = await getDoc(doc(db, 'users', userId));
        if (!userDoc.exists()) {
            showToast('Không tìm thấy người dùng', 'danger');
            return;
        }
        const userData = userDoc.data();
        const modal = createEditUserModal(userId, userData);
        document.body.appendChild(modal);
        const bsModal = new bootstrap.Modal(modal);
        bsModal.show();
        modal.addEventListener('hidden.bs.modal', () => modal.remove());
    } catch (error) {
        console.error('Error getting user data for edit:', error);
        showToast('Lỗi lấy dữ liệu người dùng', 'danger');
    }
};

function createEditUserModal(userId, userData) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.id = 'editUserModal';
    modal.setAttribute('tabindex', '-1');

    const roles = [
        { value: 'staff', label: 'Staff', color: 'info', icon: 'fas fa-user' },
        { value: 'admin', label: 'Admin', color: 'primary', icon: 'fas fa-user-tie' },
        { value: 'super_admin', label: 'Super Admin', color: 'danger', icon: 'fas fa-user-shield' }
    ];

    const statuses = [
        { value: 'pending', label: 'Chờ duyệt', color: 'warning', icon: 'fas fa-clock' },
        { value: 'approved', label: 'Đã phê duyệt', color: 'success', icon: 'fas fa-check-circle' },
        { value: 'rejected', label: 'Từ chối', color: 'danger', icon: 'fas fa-times-circle' },
        { value: 'disabled', label: 'Vô hiệu hóa', color: 'secondary', icon: 'fas fa-ban' }
    ];

    modal.innerHTML = `
        <div class="modal-dialog modal-lg">
            <div class="modal-content">
                <div class="modal-header bg-primary text-white">
                    <h5 class="modal-title">
                        <i class="fas fa-user-edit"></i> Chỉnh sửa người dùng
                    </h5>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <form id="editUserForm">
                        <!-- THÔNG TIN CƠ BẢN -->
                        <div class="row mb-3">
                            <div class="col-md-6">
                                <label class="form-label fw-bold">
                                    <i class="fas fa-user text-primary me-1"></i>Họ và tên
                                </label>
                                <input type="text" class="form-control" id="editUserName" value="${userData.name}" required>
                            </div>
                            <div class="col-md-6">
                                <label class="form-label fw-bold">
                                    <i class="fas fa-envelope text-primary me-1"></i>Email
                                </label>
                                <input type="email" class="form-control" value="${userData.email}" readonly>
                                <small class="text-muted">Không thể thay đổi</small>
                            </div>
                        </div>

                        <!-- VAI TRÒ -->
                        <div class="mb-3">
                            <label class="form-label fw-bold">
                                <i class="fas fa-user-tag text-primary me-1"></i>Vai trò
                            </label>
                            <div class="role-selector-compact">
                                ${roles.map(role => `
                                    <div class="role-compact ${userData.role === role.value ? 'selected' : ''}" data-value="${role.value}">
                                        <i class="${role.icon} text-${role.color}"></i>
                                        <span class="badge bg-${role.color}">${role.label}</span>
                                        <i class="fas fa-check-circle text-success check-icon" style="display: ${userData.role === role.value ? 'inline' : 'none'}"></i>
                                    </div>
                                `).join('')}
                            </div>
                            <input type="hidden" id="selectedRole" value="${userData.role}">
                        </div>

                        <!-- TRẠNG THÁI -->
                        <div class="mb-3">
                            <label class="form-label fw-bold">
                                <i class="fas fa-toggle-on text-primary me-1"></i>Trạng thái
                            </label>
                            <div class="status-selector-compact">
                                ${statuses.map(status => `
                                    <div class="status-compact ${userData.status === status.value ? 'selected' : ''}" data-value="${status.value}">
                                        <i class="${status.icon} text-${status.color}"></i>
                                        <span class="badge bg-${status.color}">${status.label}</span>
                                        <i class="fas fa-check-circle text-success check-icon" style="display: ${userData.status === status.value ? 'inline' : 'none'}"></i>
                                    </div>
                                `).join('')}
                            </div>
                            <input type="hidden" id="selectedStatus" value="${userData.status}">
                        </div>

                        <!-- THÔNG TIN THÊM -->
                        <div class="row">
                            <div class="col-md-6">
                                <label class="text-muted">
                                    <i class="fas fa-calendar-alt me-1"></i>
                                    Tạo: ${userData.createdAt ? userData.createdAt.toDate().toLocaleDateString('vi-VN') : 'N/A'}
                                </label>
                            </div>
                            <div class="col-md-6 text-end">
                                <label class="text-muted" id="currentStatusPreview">
                                    <!-- Updated by JS -->
                                </label>
                            </div>
                        </div>
                    </form>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">
                        <i class="fas fa-times me-1"></i> Hủy
                    </button>
                    <button type="button" class="btn btn-primary" onclick="saveUserChanges('${userId}')">
                        <i class="fas fa-save me-1"></i> Lưu thay đổi
                    </button>
                </div>
            </div>
        </div>
    `;

    // Setup event listeners
    setTimeout(() => {
        setupCompactUserModalEventListeners();
        updateCompactStatusPreview();
    }, 0);

    return modal;
}

function updateCompactStatusPreview() {
    const selectedRole = document.getElementById('selectedRole')?.value;
    const selectedStatus = document.getElementById('selectedStatus')?.value;
    const preview = document.getElementById('currentStatusPreview');
    
    if (!preview) return;

    const roleLabels = {
        'staff': 'Staff',
        'admin': 'Admin', 
        'super_admin': 'Super Admin'
    };

    const statusLabels = {
        'pending': 'Chờ duyệt',
        'approved': 'Đã phê duyệt',
        'rejected': 'Từ chối',
        'disabled': 'Vô hiệu hóa'
    };

    preview.innerHTML = `Hiện tại: ${roleLabels[selectedRole]} - ${statusLabels[selectedStatus]}`;
}

function setupCompactUserModalEventListeners() {
    // Role selection
    document.querySelectorAll('.role-compact').forEach(option => {
        option.addEventListener('click', function() {
            document.querySelectorAll('.role-compact').forEach(opt => {
                opt.classList.remove('selected');
                opt.querySelector('.check-icon').style.display = 'none';
            });
            
            this.classList.add('selected');
            this.querySelector('.check-icon').style.display = 'inline';
            document.getElementById('selectedRole').value = this.dataset.value;
            updateCompactStatusPreview();
        });
    });

    // Status selection
    document.querySelectorAll('.status-compact').forEach(option => {
        option.addEventListener('click', function() {
            document.querySelectorAll('.status-compact').forEach(opt => {
                opt.classList.remove('selected');
                opt.querySelector('.check-icon').style.display = 'none';
            });
            
            this.classList.add('selected');
            this.querySelector('.check-icon').style.display = 'inline';
            document.getElementById('selectedStatus').value = this.dataset.value;
            updateCompactStatusPreview();
        });
    });
}

function updateCurrentStatusDisplay() {
    const selectedRole = document.getElementById('selectedRole')?.value;
    const selectedStatus = document.getElementById('selectedStatus')?.value;
    const display = document.getElementById('currentStatusDisplay');
    
    if (!display) return;

    const roleConfig = {
        'staff': { color: 'info', icon: 'fas fa-user', label: 'Staff' },
        'admin': { color: 'primary', icon: 'fas fa-user-tie', label: 'Admin' },
        'super_admin': { color: 'danger', icon: 'fas fa-user-shield', label: 'Super Admin' }
    };

    const statusConfig = {
        'pending': { color: 'warning', icon: 'fas fa-clock', label: 'Chờ duyệt' },
        'approved': { color: 'success', icon: 'fas fa-check-circle', label: 'Đã phê duyệt' },
        'rejected': { color: 'danger', icon: 'fas fa-times-circle', label: 'Từ chối' },
        'disabled': { color: 'secondary', icon: 'fas fa-ban', label: 'Vô hiệu hóa' }
    };

    const role = roleConfig[selectedRole] || { color: 'secondary', icon: 'fas fa-user', label: selectedRole };
    const status = statusConfig[selectedStatus] || { color: 'secondary', icon: 'fas fa-question', label: selectedStatus };

    display.innerHTML = `
        <span class="badge bg-${role.color} me-2">
            <i class="${role.icon} me-1"></i>${role.label}
        </span>
        <span class="badge bg-${status.color}">
            <i class="${status.icon} me-1"></i>${status.label}
        </span>
    `;
}

function setupUserModalEventListeners() {
    // Role selection
    document.querySelectorAll('.role-option').forEach(option => {
        option.addEventListener('click', function() {
            // Remove selected class from all options
            document.querySelectorAll('.role-option').forEach(opt => {
                opt.classList.remove('selected');
                opt.querySelector('.role-check i').style.display = 'none';
            });
            
            // Add selected class to clicked option
            this.classList.add('selected');
            this.querySelector('.role-check i').style.display = 'block';
            
            // Update hidden input
            document.getElementById('selectedRole').value = this.dataset.value;
            updateCurrentStatusDisplay();
        });
    });

    // Status selection
    document.querySelectorAll('.status-option').forEach(option => {
        option.addEventListener('click', function() {
            // Remove selected class from all options
            document.querySelectorAll('.status-option').forEach(opt => {
                opt.classList.remove('selected');
                opt.querySelector('.status-check i').style.display = 'none';
            });
            
            // Add selected class to clicked option
            this.classList.add('selected');
            this.querySelector('.status-check i').style.display = 'block';
            
            // Update hidden input
            document.getElementById('selectedStatus').value = this.dataset.value;
            updateCurrentStatusDisplay();
        });
    });
}

window.saveUserChanges = async function(userId) {
    if (userRole !== 'super_admin') return;

    try {
        const originalUserDoc = await getDoc(doc(db, 'users', userId));
        const originalUserData = originalUserDoc.data();

        const newName = document.getElementById('editUserName').value.trim();
        const newRole = document.getElementById('selectedRole').value;
        const newStatus = document.getElementById('selectedStatus').value;

        // Validation
        if (!newName) {
            showToast('Vui lòng nhập họ tên', 'warning');
            return;
        }

        const updateData = {};
        const changes = {};

        if (newName !== originalUserData.name) {
            updateData.name = newName;
            changes.name = { from: originalUserData.name, to: newName };
        }
        if (newRole !== originalUserData.role) {
            updateData.role = newRole;
            changes.role = { from: originalUserData.role, to: newRole };
        }
        if (newStatus !== originalUserData.status) {
            updateData.status = newStatus;
            changes.status = { from: originalUserData.status, to: newStatus };
        }

        if (Object.keys(updateData).length === 0) {
            showToast('Không có thay đổi nào để lưu.', 'info');
            return;
        }

        // Xác nhận thay đổi
        const changesList = Object.entries(changes).map(([field, change]) => {
            const fieldNames = { name: 'Họ tên', role: 'Vai trò', status: 'Trạng thái' };
            return `• ${fieldNames[field]}: ${change.from} → ${change.to}`;
        }).join('<br>');

        const confirmed = await showConfirmation(
            'Xác nhận cập nhật',
            `Bạn có chắc muốn thực hiện các thay đổi sau?<br><br>${changesList}`,
            'Cập nhật',
            'Hủy',
            'question'
        );

        if (!confirmed) return;

        const batch = writeBatch(db);

        // Cập nhật user document
        batch.update(doc(db, 'users', userId), updateData);

        // Ghi log giao dịch
        const logRef = doc(collection(db, 'transactions'));
        batch.set(logRef, {
            type: 'user_management',
            userId: userId,
            userName: newName,
            userEmail: originalUserData.email,
            changes: changes,
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            timestamp: serverTimestamp()
        });

        await batch.commit();

        showToast('Cập nhật người dùng thành công!', 'success');
        bootstrap.Modal.getInstance(document.getElementById('editUserModal')).hide();
        loadUsersTable();
        updateUserManagementBadge();

    } catch (error) {
        console.error('Error saving user changes:', error);
        showToast('Lỗi khi lưu thay đổi', 'danger');
    }
}
// Load inventory table
async function loadInventoryTable(useFilter = false, page = 1) {
    try {
        const inventoryQuery = query(collection(db, 'inventory'), orderBy('name'));
        const snapshot = await getDocs(inventoryQuery);
        
        allDashboardData = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
        
        let docs = [...allDashboardData];
        
        // Apply filters if needed
        if (useFilter) {
            const codeFilter = document.getElementById('dashboardCodeFilter')?.value;
            const categoryFilter = document.getElementById('dashboardCategoryFilter')?.value;
            const stockFilter = document.getElementById('dashboardStockFilter')?.value;
            
            docs = docs.filter(data => {
                let match = true;
                
                if (codeFilter && !data.code?.toLowerCase().includes(codeFilter.toLowerCase())) {
                    match = false;
                }
                if (categoryFilter && data.category !== categoryFilter) {
                    match = false;
                }
                if (stockFilter) {
                    switch(stockFilter) {
                        case 'low':
                            if (data.quantity >= 10) match = false;
                            break;
                        case 'normal':
                            if (data.quantity < 10) match = false;
                            break;
                        case 'zero':
                            if (data.quantity !== 0) match = false;
                            break;
                    }
                }
                
                return match;
            });
        }
        
        filteredDashboardData = docs;
        currentDashboardPage = page;
        
        // Calculate pagination
        const totalItems = filteredDashboardData.length;
        const totalPages = Math.ceil(totalItems / dashboardItemsPerPage);
        const startIndex = (page - 1) * dashboardItemsPerPage;
        const endIndex = Math.min(startIndex + dashboardItemsPerPage, totalItems);
        const pageData = filteredDashboardData.slice(startIndex, endIndex);
        
        // Update table
        const tableBody = document.getElementById('inventoryTable');
        tableBody.innerHTML = '';
        
        pageData.forEach(data => {
            const row = document.createElement('tr');
            
            // Add low stock warning
            if (data.quantity < 10) {
                row.classList.add('table-warning');
            }
            
            row.innerHTML = `
                <td>${data.code}</td>
                <td>${data.name}</td>
                <td>${data.unit}</td>
                <td>${data.quantity}</td>
                <td>${data.category}</td>
                <td>${data.location}</td>
            `;
            
            tableBody.appendChild(row);
        });
        
        // Update pagination
        updateDashboardPagination(totalPages, page, totalItems, startIndex, endIndex);
        
    } catch (error) {
        console.error('Error loading inventory table:', error);
    }
}

function updateDashboardPagination(totalPages, currentPage, totalItems, startIndex, endIndex) {
    const pagination = document.getElementById('dashboardPagination');
    const paginationInfo = document.getElementById('dashboardPaginationInfo');
    
    // Update info
    paginationInfo.textContent = `Hiển thị ${startIndex + 1} - ${endIndex} của ${totalItems} kết quả`;
    
    // Create pagination HTML
    let paginationHTML = '';
    
    // Previous button
    paginationHTML += `
        <li class="page-item ${currentPage === 1 ? 'disabled' : ''}">
            <a class="page-link" href="#" data-page="${currentPage - 1}">Trước</a>
        </li>
    `;
    
    // Page numbers
    const maxVisiblePages = 5;
    let startPage = Math.max(1, currentPage - Math.floor(maxVisiblePages / 2));
    let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);
    
    if (endPage - startPage + 1 < maxVisiblePages) {
        startPage = Math.max(1, endPage - maxVisiblePages + 1);
    }
    
    for (let i = startPage; i <= endPage; i++) {
        paginationHTML += `
            <li class="page-item ${i === currentPage ? 'active' : ''}">
                <a class="page-link" href="#" data-page="${i}">${i}</a>
            </li>
        `;
    }
    
    // Next button
    paginationHTML += `
        <li class="page-item ${currentPage === totalPages || totalPages === 0 ? 'disabled' : ''}">
            <a class="page-link" href="#" data-page="${currentPage + 1}">Sau</a>
        </li>
    `;
    
    pagination.innerHTML = paginationHTML;
    
    // Add event listeners
    addPaginationEventListeners(pagination);
}

function addPaginationEventListeners(container) {
    const links = container.querySelectorAll('.page-link[data-page]');
    links.forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            const page = parseInt(this.dataset.page);
            if (page >= 1 && !this.parentElement.classList.contains('disabled')) {
                loadInventoryTable(true, page);
            }
        });
    });
}

// Check for pending users (admin only)
async function updateUserManagementBadge() {
    if (userRole !== 'super_admin') return;
    try {
        const pendingQuery = query(collection(db, 'users'), where('status', '==', 'pending'));
        const snapshot = await getDocs(pendingQuery);
        const count = snapshot.size;

        // FIX 1: Thêm kiểm tra null cho badge
        const badgeElement = document.getElementById('userCountBadge');
        if (badgeElement) {
            badgeElement.textContent = count;
            badgeElement.style.display = count > 0 ? 'inline-block' : 'none';
        }
    } catch (error) {
        console.error('Error updating user management badge:', error);
    }
}

async function checkPendingAdjustments() {
    if (userRole !== 'super_admin') return;

    try {
        const pendingQuery = query(
            collection(db, 'adjustment_requests'),
            where('status', '==', 'pending')
        );
        const snapshot = await getDocs(pendingQuery);

        const count = snapshot.size;
        document.getElementById('pendingAdjustmentCount').textContent = count;

        if (count > 0) {
            document.getElementById('pendingAdjustmentsNav').style.display = 'block';
        } else {
            document.getElementById('pendingAdjustmentsNav').style.display = 'none';
        }

    } catch (error) {
        console.error('Error checking pending adjustments:', error);
    }
}


// Load import data
function loadImportData() {
    // This will be implemented in warehouse.js
    window.loadImportSection();
}

// Load export data
function loadExportData() {
    // This will be implemented in warehouse.js
    window.loadExportSection();
}

// Load transfer data
function loadTransferData() {
    // This will be implemented in warehouse.js
    window.loadTransferSection();
}

// Load adjust data
function loadAdjustData() {
    // This will be implemented in warehouse.js
    window.loadAdjustSection();
}

// Load history data
function loadHistoryData() {
    // This will be implemented in warehouse.js
    window.loadHistorySection();
}

function saveSettings() {
    localStorage.setItem(`userSettings_${currentUser.uid}`, JSON.stringify(userSettings));
}

// 2. ÁP DỤNG CÀI ĐẶT LÊN GIAO DIỆN
function applySettings() {
    // Theme (dark/light)
    document.documentElement.setAttribute('data-theme', userSettings.theme || 'light');
    document.getElementById('darkModeSwitch').checked = (userSettings.theme === 'dark');

    // Primary Color
    const primaryColor = userSettings.primaryColor || '#007bff';
    document.documentElement.style.setProperty('--primary-color', primaryColor);
    // Cập nhật màu active cho color picker
    document.querySelectorAll('.color-box').forEach(box => {
        box.classList.remove('active');
        if (box.dataset.color === primaryColor) {
            box.classList.add('active');
        }
    });

    // Dashboard Widgets
    const showWidgets = userSettings.showStatsWidgets !== false; // Mặc định là true
    const statsRow = document.querySelector('#dashboard-section .row:first-child');
    if (statsRow) {
        statsRow.style.display = showWidgets ? '' : 'none';
    }
    document.getElementById('toggleStatsWidgetsSwitch').checked = showWidgets;
}

// 3. TẢI CÀI ĐẶT KHI VÀO TRANG
function loadSettings() {
    const savedSettings = localStorage.getItem(`userSettings_${currentUser.uid}`);
    if (savedSettings) {
        userSettings = JSON.parse(savedSettings);
    } else {
        // Cài đặt mặc định
        userSettings = {
            theme: 'light',
            primaryColor: '#007bff',
            showStatsWidgets: true
        };
    }
    applySettings();
}

// 4. XỬ LÝ ĐỔI MẬT KHẨU
async function handleChangePassword(e) {
    e.preventDefault();
    const oldPass = document.getElementById('oldPassword').value;
    const newPass = document.getElementById('newPassword').value;
    const confirmPass = document.getElementById('confirmPassword').value;

    if (newPass !== confirmPass) {
        showToast('Mật khẩu mới không khớp!', 'danger');
        return;
    }
    if (newPass.length < 6) {
        showToast('Mật khẩu mới phải có ít nhất 6 ký tự.', 'danger');
        return;
    }

    try {
        const user = auth.currentUser;
        const credential = EmailAuthProvider.credential(user.email, oldPass);

        // Firebase yêu cầu xác thực lại trước khi đổi mật khẩu
        await reauthenticateWithCredential(user, credential);

        // Nếu xác thực thành công, tiến hành đổi mật khẩu
        await updatePassword(user, newPass);
        
        showToast('Đổi mật khẩu thành công!', 'success');
        document.getElementById('changePasswordForm').reset();

    } catch (error) {
        console.error("Change Password Error:", error);
        if (error.code === 'auth/wrong-password') {
            showToast('Mật khẩu cũ không chính xác.', 'danger');
        } else {
            showToast('Có lỗi xảy ra, vui lòng thử lại.', 'danger');
        }
    }
}


// 5. KHỞI TẠO CÁC EVENT LISTENER CHO CÀI ĐẶT
function initializeSettingsListeners() {
    // Dark Mode Switch
    document.getElementById('darkModeSwitch').addEventListener('change', (e) => {
        userSettings.theme = e.target.checked ? 'dark' : 'light';
        applySettings();
        saveSettings();
    });

    // Color Theme Selector
    document.getElementById('themeColorSelector').addEventListener('click', (e) => {
        if (e.target.matches('.color-box')) {
            userSettings.primaryColor = e.target.dataset.color;
            applySettings();
            saveSettings();
        }
    });

    // Toggle Widgets Switch
    document.getElementById('toggleStatsWidgetsSwitch').addEventListener('change', (e) => {
        userSettings.showStatsWidgets = e.target.checked;
        applySettings();
        saveSettings();
    });

    // Change Password Form
    document.getElementById('changePasswordForm').addEventListener('submit', handleChangePassword);
}

// Export current user and role for use in other modules
export { currentUser, userRole };

function initializeDashboardFilters() {
    document.getElementById('filterDashboard')?.addEventListener('click', filterDashboardInventory);
    document.getElementById('clearDashboardFilter')?.addEventListener('click', clearDashboardFilter);
    document.getElementById('exportDashboardExcel')?.addEventListener('click', exportDashboardToExcel);
    
    // Load categories for filter
     loadCategoriesForFilter();
    
    // Initial load
    loadInventoryTable(false, 1);
}

async function loadCategoriesForFilter() {
    try {
        const inventoryQuery = query(collection(db, 'inventory'));
        const snapshot = await getDocs(inventoryQuery);
        
        const categories = new Set();
        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.category) {
                categories.add(data.category);
            }
        });
        
        const select = document.getElementById('dashboardCategoryFilter');
        if (select) {
            select.innerHTML = '<option value="">Tất cả danh mục</option>';
            
            [...categories].sort().forEach(category => {
                const option = document.createElement('option');
                option.value = category;
                option.textContent = category;
                select.appendChild(option);
            });
        }
        
    } catch (error) {
        console.error('Error loading categories:', error);
    }
}

// Export Excel function - CHỈ TOAST
function exportDashboardToExcel() {
    if (filteredDashboardData.length === 0) {
        showToast('Không có dữ liệu để xuất', 'warning');
        return;
    }
    
    // Prepare data for Excel
    const excelData = [
        ['Mã hàng', 'Tên mô tả', 'Đơn vị tính', 'Số lượng', 'Danh mục', 'Vị trí']
    ];
    
    filteredDashboardData.forEach(item => {
        excelData.push([
            item.code,
            item.name,
            item.unit,
            item.quantity,
            item.category,
            item.location
        ]);
    });
    
    // Create workbook
    const ws = XLSX.utils.aoa_to_sheet(excelData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Tồn kho');
    
    // Generate filename with timestamp
    const now = new Date();
    const timestamp = now.toISOString().slice(0, 19).replace(/:/g, '-');
    const filename = `ton-kho-${timestamp}.xlsx`;
    
    // Download file
    XLSX.writeFile(wb, filename);
    showToast('Đã xuất Excel thành công', 'success');
}


function filterDashboardInventory() {
    loadInventoryTable(true, 1);
}

function clearDashboardFilter() {
    document.getElementById('dashboardCodeFilter').value = '';
    document.getElementById('dashboardCategoryFilter').value = '';
    document.getElementById('dashboardStockFilter').value = '';
    loadInventoryTable(false, 1);
}