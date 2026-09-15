/** Fixed descriptor-only mechanics. Inputs are bounded data, never executable declarations. */
export const MANAGED_DIRECTORY_PROTOCOL = String.raw`
import os, sys, stat, json, hashlib, base64, ctypes, errno, fcntl
class Different(Exception): pass
class Unavailable(Exception): pass
EFFECTS=False
SUBMITTED=False
MAX_FILES=513
MAX_FILE=8*1024*1024
MAX_BYTES=33*1024*1024
DF=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
def identity(s): return (str(s.st_dev),str(s.st_ino))
def same(s, receipt): return identity(s)==(receipt['device'],receipt['inode'])
def parts(value):
    if not isinstance(value,str) or len(value)>16384 or not value or '\0' in value: raise Different()
    result=value.split('/')
    if len(result)>32 or any(p in ('','.','..') or len(p)>255 for p in result): raise Different()
    return result
def absolute(value):
    if not isinstance(value,str) or not value.startswith('/') or value=='/': raise Different()
    return parts(value[1:])
def manifest(tree):
    rows=tree['files']
    if not isinstance(rows,list) or not rows or len(rows)>MAX_FILES: raise Different()
    files={}; directories={''}; total=0
    for row in rows:
        names=parts(row['entry'])
        if row['entry'] in files or row['mode'] not in (420,493): raise Different()
        if type(row['size']) is not int or not 0<=row['size']<=MAX_FILE: raise Different()
        if not isinstance(row['sha256'],str) or len(row['sha256'])!=64 or any(c not in '0123456789abcdef' for c in row['sha256']): raise Different()
        files[row['entry']]=row
        total+=row['size']
        for i in range(1,len(names)): directories.add('/'.join(names[:i]))
    if total>MAX_BYTES or len(files)+len(directories)>MAX_FILES+33 or set(files)&directories: raise Different()
    return files,directories
def open_root(path):
    fd=os.open('/',DF)
    try:
        for name in absolute(path):
            child=os.open(name,DF,dir_fd=fd); os.close(fd); fd=child
        return fd
    except: os.close(fd); raise
def bound_root(root,expected):
    root_current(root)
    if identity(os.fstat(root))!=(expected['rootDevice'],expected['rootInode']): raise Different()
def open_parent(root, entry, create=False, expected=None):
    fd=os.dup(root); ancestors=[]; names=parts(entry)
    try:
        if expected: bound_root(root,expected)
        for i,name in enumerate(names[:-1]):
            created=False
            if create:
                if expected and i>=len(expected['ancestors']):
                    # Missing ancestors are exclusive allocations, never adoption.
                    os.mkdir(name,0o755,dir_fd=fd); created=True
                elif not expected:
                    try: os.mkdir(name,0o755,dir_fd=fd); created=True
                    except FileExistsError: pass
            child=os.open(name,DF,dir_fd=fd); os.close(fd); fd=child
            s=os.fstat(fd)
            observed={'entry':'/'.join(names[:i+1]),'device':str(s.st_dev),'inode':str(s.st_ino)}
            if expected and i<len(expected['ancestors']) and observed!=expected['ancestors'][i]: raise Different()
            if created: os.fchmod(fd,0o755)
            ancestors.append(observed)
        return fd,names[-1],ancestors
    except: os.close(fd); raise
def root_current(root):
    other=open_root(R['path'])
    try:
        if identity(os.fstat(other))!=identity(os.fstat(root)): raise Different()
    finally: os.close(other)
def location(root,entry):
    fd=os.dup(root); names=parts(entry)[:-1]; ancestors=[]; missing=[]
    try:
        for i,name in enumerate(names):
            try: child=os.open(name,DF,dir_fd=fd)
            except FileNotFoundError:
                missing=['/'.join(names[:j+1]) for j in range(i,len(names))]; break
            os.close(fd); fd=child
            s=os.fstat(fd)
            ancestors.append({'entry':'/'.join(names[:i+1]),'device':str(s.st_dev),'inode':str(s.st_ino)})
        root_current(root); rs=os.fstat(root)
        return {'root':R,'rootDevice':str(rs.st_dev),'rootInode':str(rs.st_ino),'ancestors':ancestors,'missingParents':missing}
    finally: os.close(fd)
def receipt(root, entry, s, ancestors, tree):
    rs=os.fstat(root)
    return {'root':R,'entry':entry,'device':str(s.st_dev),'inode':str(s.st_ino),'rootDevice':str(rs.st_dev),'rootInode':str(rs.st_ino),'ancestors':ancestors,'tree':tree}
def file_hash(fd, maximum):
    h=hashlib.sha256(); size=0
    while True:
        chunk=os.read(fd,min(65536,maximum-size+1))
        if not chunk: break
        size+=len(chunk)
        if size>maximum: raise Different()
        h.update(chunk)
    return size,h.hexdigest()
def verify_tree(fd, tree):
    files,dirs=manifest(tree)
    seen=set(); visited=set()
    def walk(at, prefix):
        visited.add(prefix)
        expected={p[len(prefix)+1:] if prefix else p for p in set(files)|dirs if p!=prefix and (p.startswith(prefix+'/') if prefix else True)}
        expected={p.split('/')[0] for p in expected}
        if set(os.listdir(at))!=expected: raise Different()
        for name in sorted(expected):
            entry=(prefix+'/' if prefix else '')+name
            before=os.stat(name,dir_fd=at,follow_symlinks=False)
            if entry in dirs:
                if not stat.S_ISDIR(before.st_mode) or stat.S_IMODE(before.st_mode)!=0o755: raise Different()
                child=os.open(name,DF,dir_fd=at)
                try:
                    if identity(os.fstat(child))!=identity(before): raise Different()
                    walk(child,entry)
                finally: os.close(child)
            else:
                row=files[entry]
                if not stat.S_ISREG(before.st_mode) or stat.S_IMODE(before.st_mode)!=row['mode'] or before.st_size!=row['size']: raise Different()
                child=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=at)
                try:
                    if identity(os.fstat(child))!=identity(before): raise Different()
                    if file_hash(child,row['size'])!=(row['size'],row['sha256']): raise Different()
                    after=os.fstat(child)
                    if (after.st_mtime_ns,after.st_ctime_ns,after.st_size)!=(before.st_mtime_ns,before.st_ctime_ns,before.st_size): raise Different()
                finally: os.close(child)
                if identity(os.stat(name,dir_fd=at,follow_symlinks=False))!=identity(before): raise Different()
                seen.add(entry)
        if set(os.listdir(at))!=expected: raise Different()
    walk(fd,'')
    if seen!=set(files) or visited!=dirs: raise Different()
def inspect(root, entry, tree, expected=None):
    parent,name,ancestors=open_parent(root,entry)
    try:
        s=os.stat(name,dir_fd=parent,follow_symlinks=False)
        if not stat.S_ISDIR(s.st_mode) or stat.S_IMODE(s.st_mode)!=0o755: raise Different()
        result=receipt(root,entry,s,ancestors,tree)
        if expected and any(result[k]!=expected[k] for k in ('root','entry','device','inode','rootDevice','rootInode','ancestors','tree')): raise Different()
        fd=os.open(name,DF,dir_fd=parent)
        try:
            if identity(os.fstat(fd))!=identity(s): raise Different()
            verify_tree(fd,tree)
        finally: os.close(fd)
        if identity(os.stat(name,dir_fd=parent,follow_symlinks=False))!=identity(s): raise Different()
        root_current(root)
        again,_,current=open_parent(root,entry)
        os.close(again)
        if current!=ancestors: raise Different()
        return result
    finally: os.close(parent)
def moved(r, entry):
    result=dict(r); result['entry']=entry
    return result
def rename(parent, source, destination, flags):
    return rename_to(parent,source,parent,destination,flags)
def rename_to(parent, source, destination_parent, destination, flags):
    global EFFECTS
    fn=rename_function()
    if fn(parent,source.encode(),destination_parent,destination.encode(),flags):
        e=ctypes.get_errno()
        if e in (errno.ENOSYS,errno.EINVAL,errno.EOPNOTSUPP): raise Unavailable()
        raise OSError(e,'rename refused')
    EFFECTS=True
def rename_function():
    libc=ctypes.CDLL(None,use_errno=True)
    if not hasattr(libc,'renameat2'): raise Unavailable()
    fn=libc.renameat2
    fn.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
    return fn
def prerequisites(parent):
    fn=rename_function()
    # Empty names cannot rename an object. This proves syscall/flag support only;
    # a filesystem can still reject the first actual rename without effects.
    for flags in (1,2):
        if fn(parent,b'',parent,b'',flags)==0: raise Unavailable()
        e=ctypes.get_errno()
        if e!=errno.ENOENT: raise Unavailable()
def same_parent(a,b):
    if parts(a)[:-1]!=parts(b)[:-1] or a==b: raise Different()
def emit(value):
    sys.stdout.write(json.dumps(value,separators=(',',':'))+'\n'); sys.stdout.flush()
`
